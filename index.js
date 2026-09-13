/**
 * 酒馆助手 Lite — SillyTavern 扩展（目标：ST 1.12.x ~ 1.18.x，含老内核 1.12.3）
 *
 * 设计约束：本文件不 import 任何 SillyTavern 模块。老内核缺少新模块的具名导出时，
 * ES 模块会在链接期抛 SyntaxError 导致整个扩展不执行（酒馆助手 4.9.5 在 1.12.3 上正是如此）。
 * 因此全部能力经 window.SillyTavern.getContext() 获取，缺失的能力降级禁用而非崩溃。
 *
 * 能力：
 *   1) 前端渲染 —— 把消息 code fence 里的 HTML 渲染进沙箱 iframe，并按内容自动调高。
 *   2) MVU 变量 —— 回放全部 <UpdateVariable> 块，结果写入 ST 原生 chat_metadata.variables，
 *      使 {{getvar::x}} 在提示词、STscript 与渲染后的前端里都生效；可选把变量表注入提示词。
 */
(function () {
    'use strict';

    const TAG = '[酒馆助手Lite]';
    const VERSION = '0.2.0';
    const EXT_ID = 'th_lite';
    const META_KEY = 'th_lite_mvu';
    const PROMPT_KEY = 'th_lite_vars';
    const HTML_LANGS = /^(html|htm|xhtml)$/i;
    const BLOCK_TAGS = /^(PRE|P|LI|DIV|BLOCKQUOTE|TABLE|TR|TD|SPAN|CODE)$/;

    const DEFAULTS = {
        renderEnabled: true,
        autoDetectHtml: true,
        hideUpdateBlocks: true,
        mvuEnabled: true,
        injectVars: true,
        injectDepth: 2,
        maxHeight: 1200,
        hostScripts: true,
        hostSkipBundles: true,
    };

    let ctx = null;
    let settings = Object.assign({}, DEFAULTS);
    let mvuTree = {};
    let lastError = '';
    const uids = new WeakMap();

    // ---------------------------------------------------------------- 基础设施

    function stCtx() {
        const api = window.SillyTavern;
        return api && typeof api.getContext === 'function' ? api.getContext() : null;
    }

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function loadSettings() {
        const store = ctx && ctx.extensionSettings;
        if (!store) return;
        if (!store[EXT_ID] || typeof store[EXT_ID] !== 'object') store[EXT_ID] = {};
        for (const key of Object.keys(DEFAULTS)) {
            if (typeof store[EXT_ID][key] !== typeof DEFAULTS[key]) store[EXT_ID][key] = DEFAULTS[key];
        }
        settings = store[EXT_ID];
    }

    function saveSettings() {
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }

    function chatMeta() {
        return (ctx && ctx.chatMetadata) || null;
    }

    function debug(...args) {
        console.debug(TAG, ...args);
    }

    // ---------------------------------------------------------------- MVU 变量

    /** 取文本中所有 <UpdateVariable> 块的内容。 */
    function extractBlocks(text) {
        const out = [];
        const re = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
        let m;
        while ((m = re.exec(text)) !== null) out.push(m[1]);
        return out;
    }

    /** 从括号起始位置取出配平的 JSON 片段，失败返回 null。 */
    function balancedJson(text, open, close) {
        const start = text.indexOf(open);
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    const raw = text.slice(start, i + 1);
                    try {
                        return JSON.parse(raw);
                    } catch (err) {
                        return { __parseError: String(err) };
                    }
                }
            }
        }
        return null;
    }

    function pointerParts(path) {
        if (typeof path !== 'string') return [];
        return path
            .split('/')
            .slice(1)
            .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    }

    function readPath(tree, parts) {
        let node = tree;
        for (const key of parts) {
            if (node === null || typeof node !== 'object') return undefined;
            node = node[key];
        }
        return node;
    }

    function writePath(tree, parts, value, remove) {
        if (parts.length === 0) return;
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            const next = parts[i + 1];
            if (node[key] === null || typeof node[key] !== 'object') {
                // JSON Pointer 的 "-" 与数字下标都表示数组，缺省建对象会退化成 {"-": …}
                node[key] = next === '-' || /^\d+$/.test(next) ? [] : {};
            }
            node = node[key];
        }
        const leaf = parts[parts.length - 1];
        if (remove) {
            if (Array.isArray(node)) node.splice(Number(leaf), 1);
            else delete node[leaf];
            return;
        }
        if (Array.isArray(node) && (leaf === '-' || leaf === '')) node.push(value);
        else node[leaf] = value;
    }

    function applyPatch(tree, op) {
        if (!op || typeof op !== 'object' || typeof op.op !== 'string') return;
        const parts = pointerParts(op.path);
        switch (op.op.toLowerCase()) {
            case 'add':
            case 'replace':
                writePath(tree, parts, op.value, false);
                break;
            case 'remove':
                writePath(tree, parts, undefined, true);
                break;
            case 'move': {
                const from = pointerParts(op.from);
                const value = readPath(tree, from);
                writePath(tree, from, undefined, true);
                writePath(tree, parts, value, false);
                break;
            }
            case 'copy':
                writePath(tree, parts, readPath(tree, pointerParts(op.from)), false);
                break;
            default:
                break;
        }
    }

    function deepMerge(target, source) {
        for (const key of Object.keys(source || {})) {
            const value = source[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
                deepMerge(target[key], value);
            } else {
                target[key] = value;
            }
        }
    }

    /** 宽松解析：优先 JSON Patch 数组，其次 JSON 对象，最后 key: value 行。 */
    function applyBlock(tree, blockText) {
        const arr = balancedJson(blockText, '[', ']');
        if (Array.isArray(arr)) {
            arr.forEach((op) => applyPatch(tree, op));
            return true;
        }
        const obj = balancedJson(blockText, '{', '}');
        if (obj && typeof obj === 'object' && !obj.__parseError) {
            deepMerge(tree, obj);
            return true;
        }
        const pairs = blockText.match(/^\s*([^:\n]{1,40})\s*[:=]\s*(.+?)\s*$/gm);
        if (pairs && pairs.length) {
            for (const line of pairs) {
                const idx = line.search(/[:=]/);
                const key = line.slice(0, idx).replace(/["'*\-]/g, '').trim();
                let value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
                if (key) tree[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
            }
            return true;
        }
        return false;
    }

    /** 把嵌套变量压平成 ST 原生变量表可用的 key。 */
    function flatten(tree, prefix, out) {
        for (const key of Object.keys(tree || {})) {
            const value = tree[key];
            const path = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
            else out[path] = Array.isArray(value) ? JSON.stringify(value) : value;
        }
        return out;
    }

    /** 卡里内嵌的初始变量（MVU 的"初始变量"语义），回放的起点。 */
    function cardInitialVariables() {
        const characters = (ctx && ctx.characters) || [];
        const index = Number(ctx && ctx.characterId);
        const character = Number.isInteger(index) && index >= 0 ? characters[index] : null;
        const holder = character && character.data && character.data.extensions
            ? character.data.extensions.tavern_helper || character.data.extensions.TavernHelper
            : null;
        if (!holder || !holder.variables || typeof holder.variables !== 'object') return {};
        try {
            return JSON.parse(JSON.stringify(holder.variables));
        } catch (err) {
            debug('初始变量解析失败', err);
            return {};
        }
    }

    /** 回放整段对话里的变量更新，写回 chat_metadata.variables。 */
    function recompute(force) {
        if (!settings.mvuEnabled && !force) return;
        const chat = (ctx && ctx.chat) || [];
        const tree = cardInitialVariables();
        let applied = 0;
        let lastFloor = -1;
        for (let i = 0; i < chat.length; i++) {
            const text = String((chat[i] && chat[i].mes) || '');
            if (text.indexOf('<UpdateVariable>') < 0) continue;
            for (const block of extractBlocks(text)) {
                if (applyBlock(tree, block)) {
                    applied++;
                    lastFloor = i;
                }
            }
        }
        mvuTree = tree;
        const meta = chatMeta();
        if (meta) {
            if (!meta.variables || typeof meta.variables !== 'object') meta.variables = {};
            const flat = flatten(tree, '', {});
            for (const key of Object.keys(flat)) meta.variables[key] = flat[key];
            meta[META_KEY] = { applied, lastFloor, keys: Object.keys(tree).length, at: Date.now() };
        }
        debug('变量回放完成', { applied, lastFloor, keys: Object.keys(tree).length });
    }

    function persist() {
        if (!ctx || typeof ctx.saveMetadata !== 'function') return;
        // 未打开任何对话时落盘没有意义，ST 会告警 saveChat called without chat_name
        if (typeof ctx.getCurrentChatId === 'function' && !ctx.getCurrentChatId()) return;
        Promise.resolve(ctx.saveMetadata()).catch((err) => debug('保存变量失败', err));
    }

    function pushPrompt() {
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
        const text = settings.injectVars && Object.keys(mvuTree).length
            ? '【变量表 · 由酒馆助手Lite维护】\n' + JSON.stringify(mvuTree, null, 2)
            : '';
        try {
            ctx.setExtensionPrompt(PROMPT_KEY, text, 1, settings.injectDepth, false, 0);
        } catch (err) {
            lastError = String(err && err.message ? err.message : err);
        }
    }

    /** 取楼层原文；ST 的清洗会改 DOM，判断块位置必须用原始消息文本。 */
    function rawMessageText(mesEl) {
        const id = Number(mesEl.getAttribute('mesid'));
        const chat = (ctx && ctx.chat) || [];
        const message = Number.isInteger(id) ? chat[id] : null;
        return message && typeof message.mes === 'string' ? message.mes : '';
    }

    const BLOCK_SELECTOR = 'p, li, div, pre, blockquote, td, h1, h2, h3, h4, h5, h6, code';

    /** 去掉空白与各种引号写法：ST 渲染时的空白折叠/排版差异不该影响匹配。 */
    function normalizeText(value) {
        return String(value || '').replace(/[\s"'“”‘’`]/g, '');
    }

    /**
     * 变量更新块属于控制流，不该出现在正文里。
     * ST 的消息清洗会把 <UpdateVariable> 标签剥掉只留内容，渲染还可能折叠空白、把块拆成多个节点，
     * 因此按"规范化后的内容"在块级元素上匹配；块夹在正文中间时只删块内容、保留正文。
     */
    function hideUpdateBlocks(textEl, rawText) {
        const raw = String(rawText || '');
        const literalTag = (textEl.textContent || '').indexOf('<UpdateVariable>') >= 0;
        if (raw.indexOf('<UpdateVariable>') < 0 && !literalTag) return;

        const payloads = [];
        const re = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gi;
        let match;
        while ((match = re.exec(raw)) !== null) {
            const payload = match[1].trim();
            if (payload.length >= 6) payloads.push({ raw: payload, norm: normalizeText(payload) });
        }

        for (const block of Array.from(textEl.querySelectorAll(BLOCK_SELECTOR))) {
            if (block.querySelector('iframe')) continue;
            const text = (block.textContent || '').trim();
            if (!text) continue;
            const norm = normalizeText(text);
            if (!norm) continue;
            const wholeBlock = payloads.some((p) => p.norm === norm);
            const fragment = payloads.some((p) => p.norm.length > norm.length && p.norm.indexOf(norm) >= 0);
            const onlyTag = /^<\/?UpdateVariable>$/i.test(text);
            // 原文里确有更新块时，纯 JSON 段落一律按控制块处理，覆盖空白折叠与节点拆分
            const jsonOnly = payloads.length > 0 && /^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(norm);
            if (wholeBlock || fragment || onlyTag || jsonOnly) block.remove();
        }

        const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
        const jobs = [];
        let node;
        while ((node = walker.nextNode()) !== null) {
            const value = node.nodeValue || '';
            if (!value.trim()) continue;
            if (value.indexOf('<UpdateVariable>') >= 0 || value.indexOf('</UpdateVariable>') >= 0) {
                jobs.push({ node, whole: true });
                continue;
            }
            if (payloads.some((p) => value.indexOf(p.raw) >= 0)) jobs.push({ node, whole: false });
        }

        for (const job of jobs) {
            let rest = job.whole ? '' : job.node.nodeValue;
            if (!job.whole) {
                for (const payload of payloads) rest = rest.split(payload.raw).join('');
            }
            if (rest.trim() === '') {
                let host = job.node.parentElement;
                while (host && host !== textEl && !BLOCK_TAGS.test(host.tagName)) host = host.parentElement;
                if (host && host !== textEl) host.remove();
                else job.node.remove();
            } else {
                job.node.nodeValue = rest;
            }
        }
    }

    // ---------------------------------------------------------------- 前端渲染

    function frameDoc(html, uid) {
        const css = [
            'html,body{margin:0;padding:0;background:transparent;color:inherit;',
            'font-family:inherit;font-size:inherit;line-height:inherit;overflow:hidden;}',
            'img,video{max-width:100%;}',
        ].join('');
        const reporter = [
            '(function(){',
            'function measure(){var h=0,de=document.documentElement,b=document.body;',
            // 绝对定位/100vh 的内容不在 scrollHeight 里，按所有元素的实际下边缘取最大值
            'if(b){var els=b.querySelectorAll("*");for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.bottom>h)h=r.bottom;}',
            'h=Math.max(h,b.scrollHeight,b.offsetHeight);}',
            'return Math.ceil(Math.max(h,de.scrollHeight,de.offsetHeight));}',
            'function send(){try{parent.postMessage({__thLite:1,uid:' + JSON.stringify(uid) + ',h:measure()}, "*");}catch(e){}}',
            'window.addEventListener("load",send);document.addEventListener("DOMContentLoaded",send);',
            'window.addEventListener("resize",send);',
            'try{new MutationObserver(send).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});}catch(e){}',
            'try{if(window.ResizeObserver){new ResizeObserver(send).observe(document.body||document.documentElement);}}catch(e){}',
            'try{var ims=document.querySelectorAll("img");for(var k=0;k<ims.length;k++){ims[k].addEventListener("load",send);ims[k].addEventListener("error",send);}}catch(e){}',
            'setInterval(send,1000);send();})();',
        ].join('');
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
            + html
            + '<script>' + reporter + '<\/script></body></html>';
    }

    /** 先填自家变量再交给 ST 的宏引擎，否则 {{getvar::}} 可能先被替换成空值。 */
    function expandMacros(rawHtml) {
        let html = substituteLiteVars(rawHtml);
        if (typeof ctx.substituteParams === 'function') {
            try {
                html = ctx.substituteParams(html);
            } catch (err) {
                debug('宏替换失败', err);
            }
        }
        return html;
    }

    function makeIframe(expandedHtml, uid) {
        const frame = el('iframe', 'th-lite-iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.dataset.thLiteUid = uid;
        frame.srcdoc = frameDoc(expandedHtml, uid);
        return frame;
    }

    /** wrap 上保留原始源码，变量变化后可以原地重画。 */
    function buildFrame(rawHtml, uid) {
        const html = expandMacros(rawHtml);
        const wrap = el('div', 'th-lite-frame');
        wrap.__thLiteSrc = rawHtml;
        wrap.__thLiteRendered = html;
        wrap.appendChild(makeIframe(html, uid));
        return wrap;
    }

    /** 变量更新后重画已渲染的楼层；只处理源码里含宏的块。 */
    function refreshFrames() {
        let count = 0;
        for (const wrap of document.querySelectorAll('.th-lite-frame')) {
            const raw = wrap.__thLiteSrc;
            if (typeof raw !== 'string' || raw.indexOf('{{') < 0) continue;
            const html = expandMacros(raw);
            if (wrap.__thLiteRendered === html) continue;
            wrap.__thLiteRendered = html;
            const old = wrap.querySelector('iframe');
            const uid = (old && old.dataset.thLiteUid) || 'f' + Date.now();
            wrap.replaceChildren(makeIframe(html, uid));
            count++;
        }
        return count;
    }

    window.addEventListener('message', (ev) => {
        const data = ev.data;
        if (!data || data.__thLite !== 1 || !data.uid) return;
        const frame = document.querySelector('iframe[data-th-lite-uid="' + data.uid + '"]');
        if (!frame) return;
        const height = Math.max(40, Math.min(settings.maxHeight, Number(data.h) || 0));
        if (height > 0) frame.style.height = height + 'px';
    });

    function codeLanguage(code) {
        const cls = (code.className || '') + ' ' + ((code.parentElement && code.parentElement.className) || '');
        const m = cls.match(/language-([\w-]+)/i);
        return m ? m[1] : '';
    }

    function looksLikeHtml(text) {
        const head = text.trim().slice(0, 400);
        if (!head.startsWith('<')) return false;
        if (head.indexOf('<UpdateVariable') >= 0) return false;
        return /<\/[a-z][\w-]*>/i.test(text) || /<br\s*\/?>/i.test(text);
    }

    /** 把单条消息里的 HTML 块替换成沙箱 iframe。 */
    function renderMessage(mesEl) {
        const textEl = mesEl.querySelector('.mes_text');
        if (!textEl) return 0;
        if (settings.hideUpdateBlocks) hideUpdateBlocks(textEl, rawMessageText(mesEl));

        const uidBase = String(mesEl.getAttribute('mesid') || 'x');
        let count = 0;
        const codes = textEl.querySelectorAll('pre > code');
        for (const code of codes) {
            const lang = codeLanguage(code);
            const raw = code.textContent || '';
            const declared = HTML_LANGS.test(lang);
            if (!declared && !(settings.autoDetectHtml && looksLikeHtml(raw))) continue;
            if (!raw.trim()) continue;

            const uid = uidBase + '-' + count + '-' + Math.random().toString(36).slice(2, 7);
            const holder = code.closest('pre') || code;
            holder.replaceWith(buildFrame(raw, uid));
            count++;
        }
        return count;
    }

    /** 老内核的宏引擎只做精确 key 匹配，{{getvar::x}} 这类带参宏在正文里不会被替换。 */
    function substituteLiteVars(text) {
        const meta = chatMeta();
        const vars = (meta && meta.variables) || {};
        return text.replace(/\{\{\s*(getvar|getglobalvar)\s*::\s*([^}]+?)\s*\}\}/gi, (all, kind, key) => {
            const name = key.trim();
            const value = vars[name];
            return value === undefined || value === null ? '' : String(value);
        });
    }

    function renderAll() {
        if (!settings.renderEnabled) return 0;
        let total = 0;
        for (const mesEl of document.querySelectorAll('#chat .mes')) total += renderMessage(mesEl);
        refreshFrames();
        return total;
    }

    let renderTimer = null;
    let panelRef = null;

    /** 回放变量；只有结果真的变了才落盘并重推提示词。 */
    function recomputeIfChanged() {
        const before = JSON.stringify(mvuTree);
        recompute();
        if (JSON.stringify(mvuTree) === before) return false;
        persist();
        pushPrompt();
        busEmit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, { stat_data: mvuTree });
        return true;
    }

    /** 楼层变化（AI 回复、自己发的消息、划卡、编辑、删除）统一走这一条管线。 */
    function scheduleRender(delay) {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            renderTimer = null;
            try {
                const changed = settings.mvuEnabled ? recomputeIfChanged() : false;
                renderAll();
                if (changed && panelRef) panelRef.refresh('变量已自动更新');
            } catch (err) {
                lastError = String(err && err.message ? err.message : err);
                console.error(TAG, '渲染失败', err);
            }
        }, delay === undefined ? 120 : delay);
    }

    // ---------------------------------------------------------------- 卡内脚本宿主

    const MVU_EVENTS = {
        VARIABLE_INITIALIZED: 'mvu:variable_initialized',
        VARIABLE_UPDATE_STARTED: 'mvu:variable_update_started',
        VARIABLE_UPDATE_ENDED: 'mvu:variable_update_ended',
    };
    const HOST_KEY = 'th_lite_host';

    const hostBus = new Map();
    let hostState = { key: '', results: [], nodes: [] };

    function busOn(name, handler, once) {
        if (typeof handler !== 'function') return () => {};
        if (!hostBus.has(name)) hostBus.set(name, new Set());
        const wrapped = once
            ? (payload) => { busOff(name, wrapped); handler(payload); }
            : handler;
        hostBus.get(name).add(wrapped);
        return () => busOff(name, wrapped);
    }

    function busOff(name, handler) {
        const set = hostBus.get(name);
        if (set) set.delete(handler);
    }

    function busEmit(name, payload) {
        const set = hostBus.get(name);
        if (!set) return;
        for (const handler of Array.from(set)) {
            try {
                handler(payload);
            } catch (err) {
                debug('事件处理失败', name, err);
            }
        }
    }

    /** MVU 兼容层：把 Lite 的变量树当作 MVU 的 stat_data 暴露出去。 */
    function mvuShim() {
        return {
            events: MVU_EVENTS,
            getMvuData() {
                const statData = mvuTree && typeof mvuTree === 'object' ? mvuTree : {};
                return {
                    stat_data: statData,
                    statData,
                    display_data: {},
                    initialized: Object.keys(statData).length > 0,
                };
            },
            isMvuDataReady() {
                return true;
            },
            replaceVariables(text) {
                return substituteLiteVars(String(text === undefined || text === null ? '' : text));
            },
        };
    }

    /** 只补缺失的全局；已存在（例如官方酒馆助手在跑）就不覆盖。 */
    function installHostGlobals() {
        if (typeof window.Mvu !== 'object' || window.Mvu === null) window.Mvu = mvuShim();
        if (typeof window.waitGlobalInitialized !== 'function') {
            window.waitGlobalInitialized = async (name) => {
                const started = Date.now();
                while (!window[name] && Date.now() - started < 8000) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                return window[name];
            };
        }
        if (typeof window.eventOn !== 'function') window.eventOn = (name, handler) => busOn(name, handler, false);
        if (typeof window.eventOnce !== 'function') window.eventOnce = (name, handler) => busOn(name, handler, true);
        if (typeof window.eventOff !== 'function') window.eventOff = (name, handler) => busOff(name, handler);
        if (typeof window.eventEmit !== 'function') window.eventEmit = (name, payload) => busEmit(name, payload);
    }

    /** 当前角色卡里内嵌的酒馆助手脚本。 */
    function cardScripts() {
        const characters = (ctx && ctx.characters) || [];
        const index = Number(ctx && ctx.characterId);
        const character = Number.isInteger(index) && index >= 0 ? characters[index] : null;
        const holder = character && character.data && character.data.extensions
            ? character.data.extensions.tavern_helper || character.data.extensions.TavernHelper
            : null;
        const scripts = holder && Array.isArray(holder.scripts) ? holder.scripts : [];
        return scripts.filter((s) => s && s.enabled !== false && typeof s.content === 'string' && s.content.trim());
    }

    /** 自带的 MVU/Zod 打包脚本会和 Lite 的兼容层打架，默认跳过。 */
    function isBundleScript(content) {
        return /MagVarUpdate|mvu_zod|registerMvuSchema/i.test(content);
    }

    async function runCardScripts(force) {
        if (!settings.hostScripts) return;
        const scripts = cardScripts();
        if (!scripts.length) {
            hostState = { key: '', results: [], nodes: [] };
            return;
        }
        const key = String((ctx && ctx.characterId) || '') + '#' + scripts.length;
        if (!force && hostState.key === key) return;

        // 换角色时清掉上一批脚本挂到 body 上的节点（悬浮窗这类）
        for (const node of hostState.nodes) {
            try {
                node.remove();
            } catch (err) {
                debug('清理脚本节点失败', err);
            }
        }
        const before = new Set(Array.from(document.body.children));

        installHostGlobals();
        const results = [];
        for (const script of scripts) {
            const name = script.name || script.id || '(未命名脚本)';
            if (settings.hostSkipBundles && isBundleScript(script.content)) {
                results.push(name + ': 跳过（MVU/Zod 打包脚本，由 Lite 兼容层接管）');
                continue;
            }
            try {
                const factory = new Function('return (async () => {\n' + script.content + '\n})();');
                await factory.call(window);
                results.push(name + ': 已执行');
            } catch (err) {
                const message = err && err.message ? err.message : String(err);
                results.push(name + ': 失败 ' + message);
                console.error(TAG, '卡内脚本执行失败', name, err);
            }
        }
        hostState = {
            key,
            results,
            nodes: Array.from(document.body.children).filter((node) => !before.has(node)),
        };
        busEmit(MVU_EVENTS.VARIABLE_INITIALIZED, { stat_data: mvuTree });
        debug('卡内脚本宿主完成', hostState);
    }

    // ---------------------------------------------------------------- 面板

    const STYLE = [
        '.th-lite-row{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap;}',
        '.th-lite-row>label{flex:1 1 auto;}',
        '.th-lite-note{opacity:.7;font-size:.85em;margin:2px 0;}',
        '.th-lite-frame{width:100%;margin:6px 0;}',
        '.th-lite-iframe{width:100%;height:120px;border:0;border-radius:8px;background:transparent;display:block;}',
        '.th-lite-vars{width:100%;min-height:90px;max-height:260px;font-family:monospace;font-size:.85em;}',
        '.th-lite-badge{font-size:.8em;opacity:.75;}',
    ].join('');

    function ensureStyle() {
        if (document.getElementById('th-lite-style')) return;
        const style = el('style');
        style.id = 'th-lite-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    function toggleRow(labelText, key, onChange) {
        const row = el('div', 'th-lite-row');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = Boolean(settings[key]);
        box.addEventListener('change', () => {
            settings[key] = box.checked;
            saveSettings();
            if (onChange) onChange(box.checked);
        });
        const label = el('label', null, labelText);
        label.prepend(box);
        row.appendChild(label);
        return row;
    }

    function probe() {
        const api = window.SillyTavern;
        const lines = [];
        lines.push('window.SillyTavern.getContext: ' + (api && typeof api.getContext === 'function' ? '有' : '无'));
        if (!ctx) return lines.join('\n');
        const names = [
            'chat', 'chatMetadata', 'eventSource', 'eventTypes', 'saveMetadata', 'substituteParams',
            'setExtensionPrompt', 'registerMacro', 'extensionSettings', 'saveSettingsDebounced',
            'getCurrentChatId', 'generate', 'callGenericPopup',
        ];
        for (const name of names) lines.push(name + ': ' + (ctx[name] === undefined ? '缺失' : '有'));
        lines.push('对话消息数: ' + (((ctx.chat || []).length)));
        lines.push('渲染模式: ' + (settings.renderEnabled ? '开' : '关') + ' / MVU: ' + (settings.mvuEnabled ? '开' : '关'));
        lines.push('卡内脚本: ' + (settings.hostScripts ? '开' : '关')
            + (hostState.results.length ? ' · ' + hostState.results.join(' | ') : ' · 未检测到卡内脚本'));
        lines.push('变量键数: ' + Object.keys(mvuTree).length);
        const meta = chatMeta();
        const info = meta && meta[META_KEY];
        if (info) lines.push('最近回放: 应用 ' + info.applied + ' 块, 末楼层 ' + info.lastFloor);
        if (lastError) lines.push('最近错误: ' + lastError);
        return lines.join('\n');
    }

    /** 逐楼层导出「原文 vs 渲染后 HTML」，用于定位正文里残留的控制块。 */
    function dumpDiagnostics() {
        const chat = (ctx && ctx.chat) || [];
        const lines = [
            '酒馆助手 Lite v' + VERSION,
            '消息数=' + chat.length + '  隐藏块=' + settings.hideUpdateBlocks + '  渲染=' + settings.renderEnabled,
            '变量键=' + Object.keys(mvuTree).length,
        ];
        chat.forEach((message, index) => {
            const raw = String(message.mes || '');
            const el = document.querySelector('#chat .mes[mesid="' + index + '"] .mes_text');
            if (raw.indexOf('<UpdateVariable>') < 0 && !el) return;
            lines.push('');
            lines.push('===== 楼层 ' + index + ' =====');
            lines.push('原文: ' + raw.slice(0, 320).replace(/\n/g, '\\n'));
            lines.push('渲染: ' + (el ? el.innerHTML.slice(0, 320).replace(/\n/g, '\\n') : '(没有对应 DOM)'));
        });
        return lines.join('\n');
    }

    const PREVIEW_SAMPLE = [
        '<div style="padding:10px;border-radius:10px;background:linear-gradient(135deg,#2b2b3d,#3a3a55);color:#eee">',
        '<b>前端渲染自检</b><div style="opacity:.8">好感度：{{getvar::好感度}}</div></div>',
    ].join('');

    function buildPanel() {
        ensureStyle();
        const host = document.getElementById('extensions_settings');
        if (!host) return false;

        const container = el('div', 'extension_container');
        const drawer = el('div', 'inline-drawer');
        const head = el('div', 'inline-drawer-toggle inline-drawer-header');
        head.appendChild(el('b', null, '酒馆助手 Lite'));
        const icon = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
        head.appendChild(icon);
        const body = el('div', 'inline-drawer-content');

        const status = el('div', 'th-lite-note', '');

        body.appendChild(toggleRow('前端渲染（把消息里的 HTML 渲染进沙箱 iframe）', 'renderEnabled', () => scheduleRender(0)));
        body.appendChild(toggleRow('自动识别未标注语言的 HTML 块', 'autoDetectHtml', () => scheduleRender(0)));
        body.appendChild(toggleRow('隐藏 <UpdateVariable> 块', 'hideUpdateBlocks', () => scheduleRender(0)));
        body.appendChild(toggleRow('MVU 变量（回放并写入 chat_metadata.variables）', 'mvuEnabled', () => {
            recompute(true);
            persist();
            pushPrompt();
            refresh();
        }));
        body.appendChild(toggleRow('把变量表注入提示词', 'injectVars', () => {
            pushPrompt();
            refresh();
        }));
        body.appendChild(toggleRow('运行卡内脚本（悬浮窗等酒馆助手脚本）', 'hostScripts', (on) => {
            if (on) {
                Promise.resolve(runCardScripts(true)).then(() => refresh('卡内脚本已执行'));
            } else {
                for (const node of hostState.nodes) {
                    try {
                        node.remove();
                    } catch (err) {
                        debug('清理脚本节点失败', err);
                    }
                }
                hostState = { key: '', results: [], nodes: [] };
                refresh('卡内脚本已关闭并清理挂载节点');
            }
        }));

        const depthRow = el('div', 'th-lite-row');
        depthRow.appendChild(el('label', null, '变量表注入深度'));
        const depth = el('input');
        depth.type = 'number';
        depth.min = '0';
        depth.max = '20';
        depth.value = String(settings.injectDepth);
        depth.style.width = '70px';
        depth.addEventListener('change', () => {
            settings.injectDepth = Math.max(0, Math.min(20, Number(depth.value) || 0));
            depth.value = String(settings.injectDepth);
            saveSettings();
            pushPrompt();
        });
        depthRow.appendChild(depth);
        body.appendChild(depthRow);

        const buttons = el('div', 'th-lite-row');
        const btnRender = el('div', 'menu_button', '重绘全部楼层');
        btnRender.addEventListener('click', () => {
            recomputeIfChanged();
            const n = renderAll();
            refresh('重绘完成：处理 ' + n + ' 个 HTML 块，并刷新了已渲染楼层');
        });
        const btnVars = el('div', 'menu_button', '重算变量');
        btnVars.addEventListener('click', () => {
            recompute(true);
            persist();
            pushPrompt();
            renderAll();
            refresh('变量已重算并刷新楼层');
        });
        const btnProbe = el('div', 'menu_button', '自检');
        btnProbe.addEventListener('click', () => refresh(''));
        const btnDiag = el('div', 'menu_button', '诊断正文');
        btnDiag.addEventListener('click', () => {
            probeBox.value = dumpDiagnostics();
            status.textContent = '诊断已生成：把下面文本框的内容整段复制发给我';
        });
        buttons.appendChild(btnRender);
        buttons.appendChild(btnVars);
        buttons.appendChild(btnProbe);
        buttons.appendChild(btnDiag);
        body.appendChild(buttons);

        const varsBox = el('textarea', 'text_lite_vars text_pole th-lite-vars');
        varsBox.readOnly = true;
        varsBox.placeholder = '当前变量（只读展示）';
        body.appendChild(varsBox);

        const probeBox = el('textarea', 'th-lite-vars');
        probeBox.readOnly = true;
        probeBox.placeholder = '自检输出';
        body.appendChild(probeBox);

        body.appendChild(el('div', 'th-lite-note', '预览：'));
        const preview = el('div', 'th-lite-frame');
        body.appendChild(preview);

        const pvRow = el('div', 'th-lite-row');
        const btnPreview = el('div', 'menu_button', '渲染预览');
        btnPreview.addEventListener('click', () => {
            preview.replaceChildren(buildFrame(PREVIEW_SAMPLE, 'preview-' + Date.now()));
        });
        pvRow.appendChild(btnPreview);
        body.appendChild(pvRow);

        body.appendChild(status);
        body.appendChild(el('div', 'th-lite-note', '来源：酒馆助手 Lite v' + VERSION + '（零静态 import，兼容老内核）'));

        drawer.appendChild(head);
        drawer.appendChild(body);
        container.appendChild(drawer);
        host.appendChild(container);

        function refresh(message) {
            const meta = chatMeta();
            const vars = (meta && meta.variables) || {};
            const keys = Object.keys(vars).sort();
            varsBox.value = keys.length
                ? keys.map((k) => k + ' = ' + JSON.stringify(vars[k])).join('\n')
                : '（暂无变量；模型输出 <UpdateVariable> 块或使用 {{setvar::k::v}} 后出现）';
            probeBox.value = probe();
            status.textContent = message || ('状态：已加载 · 变量 ' + Object.keys(mvuTree).length + ' 键');
        }
        refresh('');
        return { refresh };
    }

    // ---------------------------------------------------------------- 启动

    function wireEvents(panel) {
        const ev = ctx.eventSource;
        const et = ctx.eventTypes;
        if (!ev || !et || typeof ev.on !== 'function') return;
        const onRender = () => scheduleRender();
        for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
            if (et[name]) {
                try {
                    ev.on(et[name], onRender);
                } catch (err) {
                    debug('事件注册失败', name, err);
                }
            }
        }
        if (et.MESSAGE_RECEIVED) {
            // 变量回放与楼层重画都交给防抖管线，避免两条路径各刷一遍
            ev.on(et.MESSAGE_RECEIVED, () => scheduleRender(60));
        }
        if (et.CHAT_CHANGED) {
            ev.on(et.CHAT_CHANGED, () => {
                recompute(true);
                pushPrompt();
                runCardScripts();
                scheduleRender(200);
                if (panel) panel.refresh('已切换对话');
            });
        }
    }

    function boot() {
        ctx = stCtx();
        if (!ctx) {
            console.error(TAG, '未找到 window.SillyTavern.getContext()，扩展未启用');
            return;
        }
        loadSettings();
        const panel = buildPanel();
        panelRef = panel;
        if (!panel) console.warn(TAG, '未找到 #extensions_settings，面板未挂载');
        recompute(true);
        pushPrompt();
        Promise.resolve(runCardScripts()).catch((err) => debug('卡内脚本宿主失败', err));
        wireEvents(panel);
        scheduleRender(300);
        setTimeout(() => scheduleRender(0), 1500);
        console.log(TAG, '已加载（v' + VERSION + '）');
    }

    /** 供面板、STscript 与自动化验收调用的句柄。 */
    window.ThLite = {
        get context() { return ctx; },
        get settings() { return settings; },
        recompute,
        renderAll,
        pushPrompt,
        probe,
        hideUpdateBlocks,
        rawMessageText,
        dumpDiagnostics,
        get tree() { return mvuTree; },
    };

    ready(boot);
})();
