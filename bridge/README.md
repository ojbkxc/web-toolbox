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

| 工具 | 说明 | 需要 `--allow-control` | 结构化返回 |
|---|---|---|---|
| `bridge_status` | 扩展是否已连接、录制状态 | | ✓ |
| `net_list` | 列出抓到的请求（摘要，可过滤/分页） | | ✓ |
| `net_get` | 按 id 取完整请求+响应正文（结构化 `truncated`/`originalChars`/`maxBody`，不用再猜是否被截断） | | ✓ |
| `net_hosts` | 抓包域名分布（诊断漏录） | | ✓ |
| `export_har` | 导出 HAR 1.2（产物超限明确报错, 不返回半截） | | |
| `export_jmx` | 导出 JMeter 脚本（产物超限明确报错, 不返回半截） | | |
| `export_python` | 导出 requests 重放脚本（产物超限明确报错） | | |
| `correlate` | 自动关联动态值 | | ✓ |
| `tab_list` | 列出标签页（结构化 `{total, tabs}`） | | ✓ |
| `rec_start` / `rec_stop` | 开始/停止录制 | ✓ | |
| `tab_navigate` | 打开网址 | ✓ | |
| `tab_activate` / `tab_close` | 切换 / 关闭标签页 | ✓ | |
| `page_snapshot` | 页面结构快照（带 ref，穿透 shadow DOM 与同源 iframe） | ✓ | |
| `page_click` / `page_type` / `page_press` | 按 ref 交互 | ✓ | |
| `page_hover` | 悬停（展开二级菜单必需） | ✓ | |
| `page_select` | 原生下拉框选择 | ✓ | |
| `page_scroll` | 滚到元素 / 按像素 / 到底部（懒加载） | ✓ | |
| `page_wait` | 等元素/文本/URL/毫秒（比 sleep 可靠） | ✓ | |
| `page_screenshot` | 截图（返回 PNG） | ✓ | |
| `page_eval` | 页面执行 JS（只读调试用） | ✓ | |
| `chain_replay` | 链路重放 + 回归 diff（逐条 OK/DIFF/FAIL/ERR，`structuredContent` 带 `total/verdicts/failed/results`） | ✓ | ✓ |
| `console_read` | 读控制台日志（环形缓冲，最多 500 条） | | |
| `console_clear` | 清空控制台日志缓冲（不动已录请求） | ✓ | |

**结构化自校验(v1.1.15)**: 带 `outputSchema` 的工具返回前先用 zod 自己验一遍
`structuredContent` —— 不符时返回 `错误[bad_payload]: 工具 xxx 的 structuredContent 与 outputSchema 不符: 字段: 原因`
(而不是让 SDK 抛一句难读的协议错误), 顺带在开发期暴露 schema 与返回值漂移。

**等号写法(v1.1.30)**: 带值参数支持 `--port=9280` / `--token=abc==` 形式(只在已知
带值 flag 的第一个 `=` 处切, 值里允许再出现 `=`); 未知的 `--foo=bar` 仍报未知参数。

**参数校验(v1.1.14)**: `--port` 必须是 1..65535 的整数、flag 漏值/吞掉下一个 flag、
未知参数(如把 `--allow-control` 拼成 `--alow-control`)**一律在启动前报错退出(码 2)**并举出可用参数 ——
早先这些情况要么 NaN 崩在 WebSocketServer 里, 要么被静默忽略(控制类悄悄不可用)。

**过滤语义(v1.1.41)**: 侧栏搜索框是"关键词分词 AND"(人在界面上搜词), bridge 的 `net_*` 是
**字段级过滤**(按 method/status/statusMin/statusMax/pathIncludes/hostIncludes 组合, 多条件 AND)。
两套口径并存且都合理, 但**不要当成同一个东西**: `hostIncludes` 是**子串**匹配,
`api.test.com` 会同时命中 `api.test.com.cn`(要精确到域请带前导 `https://`, 或用 `net_hosts` 先看清单)。

**控制开关一致性(v1.1.26)**: 本地进程的 `--allow-control` 与 daemon 的开关是**两个**值。
代理模式下真正的闸门在 daemon —— 本地开了、daemon 没开时, 控制类工具会在 daemon 那侧被拒。
`bridge_status` 现在回 `allowControl`(本地) / `daemonAllowControl`(daemon, 单进程为 null) /
`controlMismatch`, 不再让用户对着 `forbidden` 猜该重启谁。

**工具表闸门(v1.1.13)**: 上面这张表由 `test/check_tool_table.js` 盯着 ——
工具漏登记、登记了没实现、"需要 --allow-control"列与实现不符, 都会直接红。

**参数描述(v1.1.12)**: 27 个工具的每个输入参数都有 `.describe()` —— 客户端会把描述
喂给模型, 没描述的参数等于让模型猜。`test/check_bridge_schema.js` 是闸门(漏一个就红)。

**字节口径(v1.1.10)**: `net_list` 的 `reqBytes`/`respBytes` 是 **UTF-8 字节数**
(`TextEncoder` 计), 不是 JS 字符串长度 —— 中文/emoji 每字符 3-4 字节, 旧实现用 `.length`
会低报 2-3 倍, 客户端按它算上下文预算会漏。smoke 用 `"你好"`(2 字符 6 字节) 钉住这条。

**工具注解(v1.1.6)**: 每个工具都带 MCP `annotations` —— `readOnlyHint` 区分只读与写入,
破坏性工具(page_click / page_type / page_select / page_eval / chain_replay / console_clear /
tab_close)另标 `destructiveHint`。客户端可据此对只读工具免确认、对破坏性工具二次确认,
不必靠读描述猜。注解表在 `src/tools.js` 的 `ANNOTATIONS`, 漏声明在注册时直接抛错;
`test/check_bridge_annotations.js` 钉住"注解 ↔ 注册集 ↔ 协议白名单"三方一致,
`npm run smoke` 的 `tools/list` 再验一次协议层可见性。

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

## 错误语义(客户端可机读)

工具失败一律返回 `isError: true` + 两行文本:

```
错误[no_entries]: 过滤后没有条目
下一步: 先用 net_list 看当前抓到什么; 空的话确认已开始录制且域名已授权
```

错误码分两类: 线协议码(`not_connected` / `forbidden` / `timeout` / `ext_error` …)与业务码
(`bad_args` / `no_entries` / `bad_payload` / `bad_state`)。文案与"下一步"的**唯一来源**是
`src/errors.js`; `test/check_bridge_errors.js` 钉住"码表 ↔ 线协议码 ↔ 工具层调用"三方一致。

## 归档保留期(可选)

抓包归档按天一个 `harvest-YYYY-MM-DD.jsonl`, 默认**永不清理**(删数据是不可逆动作)。

```bash
node src/index.js --daemon --archive-keep-days 30   # 启动时删掉 30 天前的日归档
```

- 只认 `harvest-YYYY-MM-DD.jsonl` 这个名字, 同目录其它文件(含非法命名)一律不碰;
- 范围校验 0..3650, `0` = 不清理(默认); 值非法时启动前报错退出(码 2), 不会先删再报错;
- 清理发生在 daemon 启动、尚未接受请求之前; 删除数量会打在启动日志里。

## 排障顺序(先 doctor, 再猜)

```bash
node src/doctor.js      # 18 项逐条 PASS/FAIL, 每条带"下一步"
```

- `依赖可加载` FAIL → 在 `bridge/` 里 `npm install`(扩展本体仍是零依赖, 这层独立)
- `daemon 端口在监听` FAIL → 常驻 daemon 没起: `node src/index.js --daemon --allow-control`
- `令牌可用` FAIL → 先起一次 daemon 让它生成 `~/.web-toolbox/bridge-token`
- `令牌被 daemon 接受` FAIL → 手里这串和 daemon 内存里的不一致(轮换过/填错), 换成它打印的那串或重启 daemon
- 全 PASS 但 AI 侧仍连不上 → 核对扩展配置页「AI 桥接」的地址/令牌是否与 doctor 打印一致

## 已知约束

- **`chrome.debugger` 单会话**：录制和页面控制都要 attach 同一个 tab。bridge 用
  "按需 attach、复用已有 attach、用完只还自己的" 策略，不会踢掉录制引擎。但同一个 tab
  不能同时被 bridge 和 Playwright 之类的外部调试器占用。
- **MV3 worker 休眠**：断线重连用 `chrome.alarms`（最小 0.4min）而不是 `setTimeout`，
  否则 worker 被回收后重连逻辑消失。Chrome 116+ 里 WebSocket 收发包本身也会续命。

## 自检

```bash
node bridge/smoke.mjs    # 端到端: 鉴权/请求响应/事件/控制开关/未连接/工具注解/错误语义/结构化返回/字节口径/分页/截断/开关不一致/导出体积守卫, 58 项
node bridge/unit.mjs     # 内部单测: register 自校验/config 参数守卫/hub 拒绝分支/代理转发/断线失败/archive 落盘+权限+保留期/net_list 3000 条规模与字段过滤边界, 71 项(需 npm install)
node bridge/test-exporters.mjs  # 导出口径单测 + 单源证明 + 清洗降级 + 异常形态(HEAD/空 body/204/超长 query/PATCH/OPTIONS/multipart/HAR size), 46 项
node bridge/test-doctor.mjs     # doctor 端到端(真起 daemon): 无 daemon/正确令牌/错令牌/参数错误 四场景, 21 项
node bridge/test-reconnect.mjs   # 桥接客户端重连语义(可控 FakeWS): 失败重连/断开恢复/hello 帧, 10 项
node bridge/test-auth.mjs        # 协议矩阵(独立 daemon): 鉴权/协议版本/白名单/控制开关, 9 项
cd bridge && npm test    # 聚合: unit → exporters → doctor → smoke, 任一层红即退出非零
node src/doctor.js          # 自检: 监听地址/node 版本/依赖/协议契约/令牌/daemon 端口/归档目录/令牌权限/扩展就位/活体握手/协议/版本一致性, 18 项
node test/check_bridge.js   # 契约走查: 协议一致性/白名单对应/录制不变量, 归入全量回归
```
