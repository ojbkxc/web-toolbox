# AI 桥接 (MCP Bridge)

把 web-toolbox 的抓包与页面能力暴露成 **MCP 工具**，供 Claude Code / Trae / Cursor 等任意 MCP 客户端调用。

## 架构

```
AI 客户端 (Claude Code / Trae / Cursor)
   │ MCP over stdio
   ▼
bridge (Node 进程, 本仓库 bridge/)
   │ WebSocket ws://127.0.0.1:9280/ext  ← 扩展主动拨出
   ▼
Chrome 扩展 (service worker, bridge-client.js)
   ├── 录制引擎 / 抓包数据 (原有, 未改动)
   └── chrome.debugger / chrome.scripting (页面控制)
```

**为什么是 WebSocket 而不是 Native Messaging**：扩展不能监听端口，只能拨出。Native Messaging
需要每台机器跑安装器、写注册表、macOS 还要签名公证。WebSocket 装了扩展就能用，
bridge 的生命周期由 AI 客户端（它本来就 spawn 子进程）管理，天然有序。

**为什么另起一个包**：扩展维持零依赖铁律（源码即产物），bridge 允许 npm 依赖。
两者之间只有 `bridge-protocol.js` 一个契约文件，为 UMD 形态，扩展 `importScripts`、
bridge `import`、node 测试 `require` 三种方式共用同一份。

## 快速开始

### 1. 装依赖

```bash
cd bridge
npm install
```

### 2. 启动常驻 daemon（必须）

```bash
node src/index.js --daemon --allow-control
```

**为什么要常驻**：MCP 客户端是「调用时才 spawn 进程」的，AI 一关进程就没了，
扩展也就断线。daemon 负责一直守着端口等扩展连上来；AI 客户端连接时自动经它转发。

`--allow-control` 打开点击/输入/导航/录制。只要抓包可以不加。

首次启动会生成令牌并打印：

```
[web-toolbox-bridge] 已生成新令牌, 保存到 ~/.web-toolbox/bridge-token
[web-toolbox-bridge] 请把这串令牌填进扩展配置页: 3f2a...
```

令牌随时可查：`cat ~/.web-toolbox/bridge-token`（Windows: `type %USERPROFILE%\.web-toolbox\bridge-token`）

### 3. 扩展连上来

1. `chrome://extensions` → Web 工具箱 → 详情 → 扩展程序选项
2. 「AI 桥接」区填：
   - 地址 `ws://127.0.0.1:9280/ext`
   - 令牌（上一步那串）
3. 点「立即连接」，显示 `✓ 已连接` 即可

### 4. 让 AI 客户端接入

```json
{
  "mcpServers": {
    "web-toolbox": {
      "command": "node",
      "args": ["D:/GitHub/web-toolbox/bridge/src/index.js", "--allow-control"]
    }
  }
}
```

Claude Code 写法（写进 `~/.claude.json` 的 `mcpServers`，全局生效）：

```bash
claude mcp add web-toolbox -s user -- node D:/GitHub/web-toolbox/bridge/src/index.js --allow-control
```

### 5. 验证

对 AI 说「用 web-toolbox 看下桥接状态」。返回 `connected: true` 即打通。

---

## 工具一览

| 工具 | 说明 | 需要 `--allow-control` |
|---|---|---|
| `bridge_status` | 扩展是否已连接、录制状态 | |
| `net_list` | 列出抓到的请求（摘要，可过滤/分页） | |
| `net_get` | 按 id 取完整请求+响应正文 | |
| `net_hosts` | 抓包域名分布（诊断漏录） | |
| `export_har` | 导出 HAR 1.2 | |
| `export_jmx` | 导出 JMeter 脚本 | |
| `export_python` | 导出 requests 重放脚本 | |
| `correlate` | 自动关联动态值 | |
| `tab_list` | 列出标签页 | |
| `rec_start` / `rec_stop` | 开始/停止录制 | ✓ |
| `tab_navigate` | 打开网址 | ✓ |
| `page_snapshot` | 页面可访问性快照（带 ref） | ✓ |
| `page_click` / `page_type` / `page_press` | 按 ref 交互 | ✓ |
| `page_screenshot` | 截图（返回 PNG） | ✓ |
| `page_eval` | 页面执行 JS（只读调试用） | ✓ |

**用 ref 不用坐标**：`page_snapshot` 给可交互元素打 `data-ai-ref="eN"`，后续按 ref 操作。
坐标对 LLM 不可靠（截图像素 vs CSS 像素、滚动失效），元素引用才是模型擅长的表达。

## 典型用法：让 AI 打开网站并点击

对 AI 说「打开 example.com，点登录按钮」时，它内部是这样走的：

```
1. tab_navigate    { url: "https://example.com" }
2. page_snapshot   →  e1 a "首页"
                      e2 button "登录"        ← AI 从这份列表里找目标
                      e3 input[name=user]
3. page_click      { ref: "e2" }             ← 真实鼠标事件(CDP dispatchMouseEvent)
```

想输入再提交：

```json
{ "name": "page_type", "arguments": { "ref": "e3", "text": "alice", "submit": true } }
```

**注意**：ref 只对最近一次 `page_snapshot` 有效。页面变化后要重新快照。
点击走的是 CDP 真实事件（不是 `el.click()`），React 受控组件、跨域 iframe 都能正常响应。


## 安全设计

- **令牌鉴权**：本地端口对本机所有进程开放，无鉴权等于把浏览器交出去。令牌只存在
  `~/.web-toolbox/bridge-token`（0600），两侧定长比较。
- **控制开关**：控制类工具默认关闭，必须 `--allow-control`。工具层与 hub 层各判一次。
- **方法白名单**：`bridge-protocol.js` 的 `READ_METHODS` / `CONTROL_METHODS` 是唯一真相；
  `test/check_bridge.js` 断言扩展 `bridgeDispatch` 的分支与白名单严格一一对应。
- **录制不变量**：桥接层只读 `toolbox.harvest`，永不写。测试里钉死。

## 已知约束

- **`chrome.debugger` 单会话**：录制和页面控制都要 attach 同一个 tab。bridge 用
  "按需 attach、复用已有 attach、用完只还自己的" 策略，不会踢掉录制引擎。但同一个 tab
  不能同时被 bridge 和 Playwright 之类的外部调试器占用。
- **MV3 worker 休眠**：断线重连用 `chrome.alarms`（最小 0.4min）而不是 `setTimeout`，
  否则 worker 被回收后重连逻辑消失。Chrome 116+ 里 WebSocket 收发包本身也会续命。

## 自检

```bash
node bridge/smoke.mjs    # 端到端: 鉴权/请求响应/事件/控制开关/未连接, 14 项
node test/check_bridge.js   # 契约走查: 协议一致性/白名单对应/录制不变量, 归入全量回归
```
