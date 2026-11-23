# 安全模型(SECURITY)

web-toolbox 是一套**本机浏览器自动化工具**: Chrome 扩展负责录制/操作页面, `bridge/` 把能力
暴露成 MCP 工具给本机的 AI 客户端。它的安全边界不是"互联网服务", 而是**你自己的机器和浏览器**。
这份文档写清: 谁能触达什么、界面上那些开关各自挡什么、以及哪些事本工具**不做**。

## 范围(Scope)

在范围内:
- 扩展对页面做的读取与操作(录制、截图、点击、输入、执行 JS);
- `bridge/` 的本地监听与令牌鉴权;
- 数据落点:`chrome.storage.local`、`~/.web-toolbox/`(令牌、归档)。

不在范围内(本工具不承诺防护):
- 已在你机器上以你的身份运行的恶意进程 —— 它能读 `~/.web-toolbox/bridge-token`, 等价于拿到令牌;
- 你在被授权域名里主动喂给页面的恶意内容(它本来就在你浏览器里跑);
- 公网暴露面: 本工具默认只监听 `127.0.0.1`。

## 三道闸门

### 1. 域名授权(`optional_host_permissions`)

- 安装后**对任何站点都无权限**。你在配置页添加 `example.com` 才授权 `*.example.com`(https+http);
  加 `sub.example.com` 只授权该主机; 加 `localhost` / `127.0.0.1` 精确授权本机开发地址。
- 撤销: 列表里删除域名会同时撤销对应 origins; 行内编辑采用"先申请新授权, 成功再撤旧"的顺序,
  拒绝弹窗会保持原配置(不会两头落空)。
- 这条闸门挡的是"扩展顺手去读别的站"。

### 2. 桥接令牌(`~/.web-toolbox/bridge-token`)

- 本地端口对本机所有进程开放, 所以必须有鉴权: 令牌随机生成(48 hex), 存用户目录(0600),
  两侧定长比较(`crypto.timingSafeEqual`)。
- 令牌轮换后旧客户端会连不上 —— `node bridge/src/doctor.js` 的「令牌被 daemon 接受(活体握手)」
  就是用 daemon 自己的令牌验你手里这串。
- 扩展配置页填一次即可; 不要把它写进任何会外发的文件。

### 3. 控制开关(`--allow-control`)

- 默认**只读**: 抓包、导出、关联、读控制台。
- 加 `--allow-control` 才允许: 录制启停、导航/切页/关页、点击/输入/按键/悬停/下拉/滚动/等待、
  截图、页面执行 JS、链路重放、清控制台。
- 工具层与 hub 层各判一次; 每个工具在 `tools/list` 里带 `readOnlyHint` / `destructiveHint`
  注解, 客户端可据此对破坏性工具要求二次确认。

## 监听地址

- 默认 `127.0.0.1`。改成 `0.0.0.0` / 局域网 IP 等于把浏览器控制面挂到网络上, **令牌成为唯一防线**;
  `doctor` 会就这一点给出 FAIL 提示(「监听地址是本机回环」)。
- 端口默认 `9280`; `--port` 会被校验(1..65535), 未知参数直接报错退出。

## 数据落点与卫生

- **不外发**: 录制数据、Cookie、Token 都留在本机。AI 分析走你配置的端点(默认本地代理
  `http://127.0.0.1:8787`), 发出去前扩展侧统一执行: 剔除 `Cookie`/`Authorization`、
  长 token 打码、body/响应按上限截断。
- **单源可验证**(v1.1.43): 所有外发 prompt 都由 `aireport.js` 的 10 个 `build*Prompt` 产出,
  **每个内部都调清洗**, 且每处 `callLlm` 的宿主函数都必须经 `build*Prompt`
  —— 由 `test/check_ai_egress.js` 逐条断言(唯一例外是选项页「测试连接」, 它只发固定探测文本,
  白名单本身也要通过"不接触录制数据"的自检)。
- **`chrome.storage.local`**: 录制会话(带 `{v, entries}` 信封, 单会话上限 3000 条)。
- **`~/.web-toolbox/archive/`**: 可选的按天 JSONL 长归档(0600), 与扩展内数据同源同口径;
  内容是**明文流量**, 含业务参数, 不需要就关掉(`--archive-dir` 指到临时目录或删掉即可)。
  长期运行建议加 `--archive-keep-days N` 自动清理旧日归档(默认 0 = 永不清理, 只认
  `harvest-YYYY-MM-DD.jsonl` 命名, 不碰同目录其它文件)。
- **Cookie 桥导出**: `cookies_*.state.json` 里是**会话凭据**, 和密码同级对待; 别提交进仓库。

## JavaScript 执行面(`page_eval`)

- 在页面 MAIN world 执行任意 JS, 等价于你在该页 DevTools 控制台手打 —— 能读该页的 DOM/存储,
  也能改它。注解标 `destructiveHint: true`。
- 只对你已授权、且你信任的页面使用; 别把不可信输入(网页文本/外部 prompt)直接拼进来执行。

## 已知的"不做"

- 不做进程隔离: 以同一用户身份运行的程序天然能读令牌与归档;
- 不做加密存储: 令牌/归档是明文文件, 靠文件权限与用户目录 ACL 保护;
- 不隐藏行为: 录制期间 Chrome 会显示「正在调试此浏览器」黄条, 这是 `chrome.debugger` 的固有提示。

## 版本与最小权限

- 扩展权限清单固定为 `cookies / storage / activeTab / scripting / debugger / tabs / alarms / sidePanel`,
  域名走 `optional_host_permissions`; 新增权限属于"影响安装信任面"的改动(见 `AGENTS.md` §5)。
- 桥接依赖在 `bridge/package.json`(独立 npm 包); 扩展本体保持零依赖。

## 报告问题

安全相关请附: 触发的工具/按钮、`node bridge/src/doctor.js` 输出、以及能复现的最小步骤。
涉及令牌或会话数据时请先打码, 不要贴原始值。
