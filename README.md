# 酒馆助手 Lite

给**老内核酒馆**（如 SillyTavern 1.12.3）用的轻量扩展：**HTML 前端渲染 + MVU 变量**。
零静态 `import`，全部能力走 `window.SillyTavern.getContext()`，兼容 1.12.x ~ 1.18.x。

---

## 为什么需要它

官方酒馆助手（JS-Slash-Runner）3.3 以上和 4.x 会在加载时 `import` 新内核才有的导出：

```
getCurrentLocale          <- scripts/i18n.js
showFontAwesomePicker     <- scripts/utils.js
stopGeneration / unshallowCharacter / default_user_avatar  <- script.js
extensionTypes            <- scripts/extensions.js
world_info_include_names / loadWorldInfo                   <- scripts/world-info.js
```

ES 模块导入一个**不存在的具名导出**是**链接期 SyntaxError**：整个扩展包不会执行，所以扩展面板里
什么都不显示（而"已安装扩展"列表读的是服务器文件夹，仍会显示已安装 + 已勾选），并且界面上没有任何提示。

本扩展不 `import` 任何 ST 模块，因此**不可能**出现这个问题。

## 能力

| 能力 | 说明 |
|---|---|
| 前端渲染 | 把消息里 ` ```html ` 代码块（可选自动识别像 HTML 的块）渲染进 `sandbox="allow-scripts"` 的 iframe，按内容自动调高；渲染前先做宏替换（`{{char}}`/`{{user}}`/`{{getvar::x}}`） |
| MVU 变量 | 回放整段对话里的 `<UpdateVariable>` 块，支持 JSON Patch 数组、JSON 对象、`key: value` 行；结果写入 ST 原生 `chat_metadata.variables` |
| AI 自动变化 | AI 回复里带变量更新时**自动**回放并重画界面卡片，不需要点任何按钮；划卡/编辑/删除楼层后会重新回放，界面随之刷新 |
| 变量可用性 | 因为写的是**原生**变量表，`{{getvar::x}}` 在提示词、STscript 和渲染后的前端里都能用 |
| 隐藏控制块 | `<UpdateVariable>` 从正文隐藏 |
| 提示词注入 | 可选把变量表注入提示词（位置 IN_CHAT、深度可调） |
| 卡内脚本宿主 | 读取当前角色卡内嵌的酒馆助手脚本并执行（悬浮窗、状态强制等）；提供 `Mvu` / `eventOn` / `waitGlobalInitialized` 最小兼容层，并跳过自带 MVU/Zod 打包的脚本 |
| 面板 | 开关、重绘全部楼层、重算变量、自检、诊断正文、渲染预览 |

## 安装

### A. 本地酒馆（最简单）

把 `manifest.json` 与 `index.js` 放进：

```
<酒馆目录>/public/scripts/extensions/third-party/TavernHelperLite/
```

刷新页面即可。

### B. 托管实例（用「安装扩展」面板）

1. GitHub 网页 → **New repository** → 选 **Public** → 名字如 `tavern-helper-lite` → Create。
2. 在该仓库 **Add file → Create new file**：
   - 文件名 `manifest.json`，把本目录同名文件的内容粘进去 → Commit。
   - 再建 `index.js`，把内容粘进去 → Commit。
3. 在那台实例点 **安装扩展**，填 `https://github.com/<你的用户名>/tavern-helper-lite` → 确定。
4. 刷新页面 → 扩展面板出现「酒馆助手 Lite」。

说明：1.12.3 的安装器只做 `git clone <URL> --depth 1`（不接受 branch/tag），仓库默认分支即可。
本扩展的 `manifest.json` 里 `auto_update` 为 `false`，不会被自动拉更新。

### C. 只做验证（不装文件）

扩展是纯客户端脚本。在没有安装权限的实例上，可以在页面 F12 → Console 里直接粘贴 `index.js` 全文回车，
效果与安装一致（本项目的验收就是这么做的）。

## 用法

让模型在消息里用 ` ```html ` 输出界面即可；变量更新写成：

```xml
<UpdateVariable>{"好感度": 10}</UpdateVariable>
```

或 JSON Patch（支持 `add/replace/remove/move/copy`，`-` 表示数组追加）：

```xml
<UpdateVariable>[{"op":"replace","path":"/好感度","value":55},{"op":"add","path":"/物品/-","value":"玉佩"}]</UpdateVariable>
```

前端 HTML 里可直接写 `{{getvar::好感度}}`。变量按聊天隔离，存在 `chat_metadata.variables`。

## 实测记录

| 环境 | 方式 | 结果 |
|---|---|---|
| SillyTavern 1.12.3（真机实例） | 无头 Chrome + CDP 注入源码运行 | **25 项检查 24 通过**；唯一失败项来自平台自带 `i18n.js` 的初始化报错，与本扩展无关 |
| SillyTavern 1.18.0（本机，临时数据目录） | 无头 Chrome + CDP 真实安装加载 | 13/14 通过（唯一失败项是 ST 自身的扩展自动更新连不上 GitHub，与本扩展无关） |

覆盖：扩展执行、面板挂载、API 自检、HTML→沙箱 iframe、iframe 内容与自动高度、JSON Patch 覆盖、
嵌套变量压平进原生变量表、数组追加、**AI 回复自动回放变量**、**已渲染卡片随变量自动重画**、
控制块隐藏（含 ST 清洗掉标签只留内容的情形；只删块内容、保留同段正文）、变量表注入、无未捕获异常。

## 已知限制

- 不实现官方酒馆助手的脚本库、MVU 的 Zod schema / 自定义 DSL、楼层操作 API 等。
- iframe 只给 `allow-scripts`（不给 `allow-same-origin`），前端脚本**读不到**酒馆页面 DOM —— 这是安全取舍，官方酒馆助手是直接挂 DOM 的。
- 老内核的宏引擎只做精确 key 匹配（不支持 `{{宏::参数}}`），所以正文里的 `{{getvar::x}}` 由本扩展在渲染时替换；提示词侧依赖变量表注入。
- 变量没有清理机制：删除扩展后，`chat_metadata.variables` 里的值仍留在聊天文件中。

## 卸载

删除 `TavernHelperLite` 文件夹并刷新页面。
