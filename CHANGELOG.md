# 更新记录

## v1.1.52 — 选项页「AI 桥接」区行为级断言

- **缺口**: 桥接连接是"用户填一次然后就不管"的配置面, 但选项页的域名/LLM 两区有走查、
  **桥接区零行为断言** —— 坏了用户只会觉得"AI 连不上", 无法定位扩展侧还是 bridge 侧。
- **新增** `test/check_options_bridge.js`(10 条, vm 跑真实 options.js):
  非法地址(http:// 前缀)拦截且不落库; 空令牌保存成功但明示"不会连接";
  bridgeStatus 三分流(connected → ✓ / lastError 透出 / 无响应给指引, 不静默空串);
  已存配置回填 url/token/enabled。
- **踩坑**(R60 教训再现): `chrome.runtime.sendMessage({type:"bridgeStatus"})` 走
  await 形式(无回调), 而 getDomains 走回调式 —— 桩必须**双形态**, 只支持一种时
  testBridge 的重试拿到 undefined 会伪装成"未连接"。

## v1.1.51 — docs/ 目录: MCP 接入指南 + 排障指南

- 参考仓库把"接入各客户端"与"排障"拆成 docs/ 独立文档; 本仓库此前这些内容散在
  README(3.7 万字节)与 bridge/README 里, 新用户要翻很久。新增:
  - `docs/mcp-clients.md`: 一分钟起步、Claude Code/Cursor/Trae 配置样例、连接拓扑
    (daemon 为何必须常驻)、工具分层表、常见问题、验证命令;
  - `docs/troubleshooting.md`: 按症状组织(连不上 / forbidden / 录不到 / 导出过大 /
    重放差异 / 退出码 2), 每条"第一步查什么 → 根因 → 修法", 顶部引导先跑 doctor。
- README 加"深入文档"入口表; 目录树补 docs/。
- 闸门: `check_doc_counts` 断言两个指南存在且被 README 链接(删文件/改路径当轮即红)。

## v1.1.50 — 动态按钮绑定完整性

- **问题形态**: 侧栏 11 个按钮是 innerHTML 模板动态生成的(格式卡片/链预览/详情),
  生成后必须再绑 onclick —— 漏绑一个 = "点击无反应"的静默故障, 静态检查只证明函数存在,
  证明不了按钮真被接上。
- **新增** `test/check_sidepanel_handlers.js`(5 条): 模板里的每个按钮 id 必须在**模板外**
  有绑定引用; 98 个绑定引用的 id 必须有声明面(HTML 静态 / 字符串拼接模板 / `.id =` 赋值
  —— 全量 JS 里认三种动态声明形态); addEventListener 同口径; 含闸门自证。

## v1.1.49 — 样本证据链闸门

- **实测缺口**: `opensource/headless-recorder` 样本目录**从未出现在 INDEX.md 的目录树里**
  (它是 UI 范式参照样本, entries=0, 不进引擎回归 —— 所以也没被任何回归拉起提醒过);
  另有样本的 `meta.url` 未脱敏核验。
- **新增** `test/check_sample_evidence.js`(6 条): 每个样本目录必须在 INDEX 被提及、
  `sample.json` 必填 source/entries 且条数与 loader 实载一致、meta.url 不指向真实内网域
  (白名单: 保留域 + RFC/开源文档域)、两组闸门自证。
- INDEX 补 `headless-recorder` 一行(注明 entries=0 不进引擎回归的角色);
  `datatracker.ietf.org`(OAuth2 样本引 RFC 6749)进白名单。

## v1.1.48 — 用户旅程可用性(快捷键 + popup 状态机)

- **补 manifest `commands`**: 之前 `chrome://extensions/shortcuts` 是**空的** —— 用户按快捷键没反应
  也无处发现能力。新增 `toggle-recording`(Ctrl+Shift+Y) / `open-side-panel` / `open-options`,
  background 用**已有** `toolboxHandleMessage` 路径处理, 不写第二套逻辑。
- **新增 `test/check_user_journey.js`**(12 条): manifest commands 形态、popup 五键、侧栏空态,
  以及 popup 状态机按钮显隐的**行为级**断言(idle/recording/paused/未配置域名 四态)。
- **踩坑(全部是测试桩的错, 不是产品错)**: ①`common.getDomains` 用**回调式** storage.get,
  我的 async 桩不调 cb → refresh 永远 pending → 四条断言一条没跑(输出仅 9 行);
  ②`containsOrigin` 同理走回调; ③`shown()` 判据把 `style.display === ""` 当成隐藏,
  导致四项全红(UI 其实是对的)。**教训: 桩要照 Chrome API 的真实形态写(回调/async 双形态)**。

> 只记"改了什么、为什么、证据在哪"。完整评审过程见 [REVIEW.md](./REVIEW.md)。

## v1.1.47 — 工具行为级覆盖与规则闭环(2026-11-23)

> 这一版没有新功能, 全部是把"写下来的规则"变成"会红的测试"。
> 累计 13 个提交: 修掉 4 类静默缺陷, 补 13 道契约闸门, 工具行为覆盖 14/27 → 27/27。

### 修掉的真缺陷(每条都有可复现证据)

- **测试环境性假红**: 测试用 `execSync(cmd, { shell: "bash" })` 跑 python, PATH 无 bash 的机器上
  `spawnSync bash ENOENT` → 46 项里 4 项必红。改为直呼解释器 + 纯 JS `checkXml`, 缺解释器打
  `SKIP(env)` 并计入摘要。
- **`options` 并发添加丢域名**: `addDomain` 用闭包里的旧清单回写, 同一瞬间两次添加只剩一个
  (实测 `sub.example.com` + `example.com` 只留后者)。加 `domainQueue` 串行锁, 锁内以存储为准。
- **MCP 工具零注解 / 错误不可机读**: 27 个工具全裸奔(客户端分不清只读与破坏性); 错误只有一句话
  (无法按码分流)。补 `annotations` + `errors.js` 单一真相(`错误[code]: 原因` + `下一步: 动作`)。
- **`reqBytes/respBytes` 用 `.length` 冒充字节**: 中文低报 2-3 倍; 改 `TextEncoder` 计 UTF-8 字节。
- **HAR `content.size` 缺失**: 消费方按 0 汇总传输量; 补上并把"响应头恒空是引擎能力边界"写进注释。
- **导出产物无体积守卫**: 实测 3000 条会造 JMX 6.7MB / HAR 5.3MB, 现在超限**明确失败并给出路**
  (不返回半截脚本 —— 半截 JSON 不是 HAR)。
- **CLI 错参数静默/NaN**: `--alow-control` 被忽略(控制类悄悄不可用)、`--port http` NaN 崩在
  WebSocketServer 里; 现在启动前报错退出(码 2)并列出可用参数。

### 新增的 13 道闸门(缺一即红)

文档计数/版本 · 工具表↔实现与两列标记 · schema 描述与形态 · 安全事实↔SECURITY · UI id 接线 ·
走查清单完整性 · 脚本目标存在 · 域名(含自证) · AI 外发单源 · 工具行为覆盖 · 仓库硬规则
(不许注释掉断言/不许框架级 skip/`process.exit(0)` 只在末尾/不许全量 add/零依赖) ·
sample 结构样本合成保留域后真跑 · 文档间链接无断链。

### 数字(全部本机实跑, 非转述)

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **64/64**(连跑 3 次) |
| 桥接端到端 | `node bridge/smoke.mjs` | **74/74** |
| 桥接单测 | `node bridge/unit.mjs` | 71/71 |
| 导出器 | `node bridge/test-exporters.mjs` | 46/46 |
| doctor e2e | `node bridge/test-doctor.mjs` | 21/21 |
| 自检 | `node bridge/src/doctor.js` | 18/18 |

### 已知未做(等你定, 都属 AGENTS §5 ask-first)

1. **200KB 字符 → 字节**: 录制上限目前按字符数算, 中文实际落盘体积可达标称 3 倍。
2. **响应头落库**: HAR `response.headers` 恒空(引擎只存请求头), 要补需改 CDP `responseReceived`。
3. **JMX 超长 query**: 现在只有 `HTTPSampler.path` 内联形态, 可选额外产出 `Arguments` 版本。
