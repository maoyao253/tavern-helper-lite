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

    /** 回放整段对话里的变量更新，写回 chat_metadata.variables。 */
    function recompute(force) {
        if (!settings.mvuEnabled && !force) return;
        const chat = (ctx && ctx.chat) || [];
        const tree = {};
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
        if (ctx && typeof ctx.saveMetadata === 'function') {
            Promise.resolve(ctx.saveMetadata()).catch((err) => debug('保存变量失败', err));
        }
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

    /** 变量更新块属于控制流，不该出现在正文里。 */
    function hideUpdateBlocks(textEl) {
        const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
        const targets = [];
        let node;
        while ((node = walker.nextNode()) !== null) {
            if (node.nodeValue && node.nodeValue.indexOf('<UpdateVariable>') >= 0) targets.push(node);
        }
        for (const textNode of targets) {
            let host = textNode.parentElement;
            while (host && host !== textEl && !BLOCK_TAGS.test(host.tagName)) host = host.parentElement;
            if (host && host !== textEl) host.remove();
            else textNode.remove();
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
            'function send(){try{parent.postMessage({__thLite:1,uid:' + JSON.stringify(uid) + ',',
            'h:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)}, "*");}catch(e){}}',
            'window.addEventListener("load",send);document.addEventListener("DOMContentLoaded",send);',
            'try{new MutationObserver(send).observe(document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}',
            'setInterval(send,1000);send();})();',
        ].join('');
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
            + html
            + '<script>' + reporter + '<\/script></body></html>';
    }

    function makeFrame(html, uid) {
        const wrap = el('div', 'th-lite-frame');
        const frame = el('iframe', 'th-lite-iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.dataset.thLiteUid = uid;
        frame.srcdoc = frameDoc(html, uid);
        wrap.appendChild(frame);
        return wrap;
    }

    window.addEventListener('message', (ev) => {
        const data = ev.data;
        if (!data || data.__thLite !== 1 || !data.uid) return;
        const frame = document.querySelector('iframe[data-th-lite-uid="' + data.uid + '"]');
        if (!frame) return;
        const height = Math.max(60, Math.min(settings.maxHeight, Number(data.h) || 0));
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
        if (settings.hideUpdateBlocks) hideUpdateBlocks(textEl);

        const uidBase = String(mesEl.getAttribute('mesid') || 'x');
        let count = 0;
        const codes = textEl.querySelectorAll('pre > code');
        for (const code of codes) {
            const lang = codeLanguage(code);
            const raw = code.textContent || '';
            const declared = HTML_LANGS.test(lang);
            if (!declared && !(settings.autoDetectHtml && looksLikeHtml(raw))) continue;
            if (!raw.trim()) continue;

            let html = raw;
            if (typeof ctx.substituteParams === 'function') {
                try {
                    html = ctx.substituteParams(raw);
                } catch (err) {
                    debug('宏替换失败', err);
                }
            }
            html = substituteLiteVars(html);

            const uid = uidBase + '-' + count + '-' + Math.random().toString(36).slice(2, 7);
            const holder = code.closest('pre') || code;
            holder.replaceWith(makeFrame(html, uid));
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
        return total;
    }

    let renderTimer = null;
    function scheduleRender(delay) {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            renderTimer = null;
            try {
                renderAll();
            } catch (err) {
                lastError = String(err && err.message ? err.message : err);
                console.error(TAG, '渲染失败', err);
            }
        }, delay === undefined ? 120 : delay);
    }

    // ---------------------------------------------------------------- 面板

    const STYLE = [
        '.th-lite-row{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap;}',
        '.th-lite-row>label{flex:1 1 auto;}',
        '.th-lite-note{opacity:.7;font-size:.85em;margin:2px 0;}',
        '.th-lite-frame{width:100%;margin:6px 0;}',
        '.th-lite-iframe{width:100%;height:90px;border:0;border-radius:8px;background:transparent;display:block;}',
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
        lines.push('变量键数: ' + Object.keys(mvuTree).length);
        const meta = chatMeta();
        const info = meta && meta[META_KEY];
        if (info) lines.push('最近回放: 应用 ' + info.applied + ' 块, 末楼层 ' + info.lastFloor);
        if (lastError) lines.push('最近错误: ' + lastError);
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
            const n = renderAll();
            refresh('重绘完成，处理 ' + n + ' 个 HTML 块');
        });
        const btnVars = el('div', 'menu_button', '重算变量');
        btnVars.addEventListener('click', () => {
            recompute(true);
            persist();
            pushPrompt();
            refresh('变量已重算');
        });
        const btnProbe = el('div', 'menu_button', '自检');
        btnProbe.addEventListener('click', () => refresh(''));
        buttons.appendChild(btnRender);
        buttons.appendChild(btnVars);
        buttons.appendChild(btnProbe);
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
            const html = substituteLiteVars(typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(PREVIEW_SAMPLE)
                : PREVIEW_SAMPLE);
            preview.replaceChildren(makeFrame(html, 'preview-' + Date.now()));
        });
        pvRow.appendChild(btnPreview);
        body.appendChild(pvRow);

        body.appendChild(status);
        body.appendChild(el('div', 'th-lite-note', '来源：酒馆助手 Lite v0.1.0（零静态 import，兼容老内核）'));

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
            ev.on(et.MESSAGE_RECEIVED, () => {
                if (!settings.mvuEnabled) return;
                recompute();
                persist();
                pushPrompt();
                if (panel) panel.refresh('变量已随新消息更新');
            });
        }
        if (et.CHAT_CHANGED) {
            ev.on(et.CHAT_CHANGED, () => {
                recompute(true);
                pushPrompt();
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
        if (!panel) console.warn(TAG, '未找到 #extensions_settings，面板未挂载');
        recompute(true);
        pushPrompt();
        wireEvents(panel);
        scheduleRender(300);
        setTimeout(() => scheduleRender(0), 1500);
        console.log(TAG, '已加载（v0.1.0）');
    }

    /** 供面板、STscript 与自动化验收调用的句柄。 */
    window.ThLite = {
        get context() { return ctx; },
        get settings() { return settings; },
        recompute,
        renderAll,
        pushPrompt,
        probe,
        get tree() { return mvuTree; },
    };

    ready(boot);
})();
