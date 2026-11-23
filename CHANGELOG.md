# 更新记录

## v1.1.59 — docs/skills.md(生成式 AI 技能参考)

- 参考仓库有 skills/ 目录(每个技能一份 SKILL.md); 本仓库十技能的说明散在 README 与测试
  注释里。新增 `bridge/gen-skills-doc.cjs` → `docs/skills.md`(技能表 + 数据卫生边界),
  由 `check_tool_reference` 的同一闸门保证与 skill.js **逐字节同步**。

## v1.1.58 — docs/tool-reference.md(生成式工具参考)

- **动机**: 参考仓库有独立的 tool-reference 文档(按类别/逐工具/参数表); 本仓库的参数信息
  只在 bridge/README 的工具表里一笔带过。手写第二份必然漂移(R9 工具表漏三行的同款教训)。
- **做法**: 新增 `bridge/gen-tool-reference.cjs`(生成器, 从 tools.js 抽 name/title/描述/
  参数+describe/注解/结构化标记, 按七层分组) → 生成 `docs/tool-reference.md`(294 行,
  20 张参数表); 新增 `check_tool_reference` 闸门: **重生成后逐字节比对**, 手改即红,
  并在失败信息里给前三行 diff 与重跑命令。
- README 的"深入文档"入口表加一行(标明"生成式")。
- 生成器说明写在文档头部: "不要手改"。

## v1.1.57 — 性能基线(先量后断)

- **动机**: R15 曾给 net_list 设 <1000ms 断言, 全量套件并发时被机器抖动打红(R26 记录);
  正确姿势是先量出**实测基线**, 再取 8~25 倍做"病态退化线"。
- **新增** `bridge/test-perf.mjs`(4 条, 基线全部本机实测):
  checkXml 500 条 ~16ms→300ms / net_list 3000 条 UTF-8 字节摘要 ~2ms→100ms /
  buildHAR 1000 条中文 ~8ms→200ms / buildJmx 500 条全管线 ~15ms→400ms。
- 基线数字写在测试头部注释; 改实现时同步更新, 断言只拦**数量级退化**(比如有人把
  TextEncoder 换回 .length 之类不会红 —— 那是语义问题由别的闸门管; 但 O(n²) 化会红)。

## v1.1.56 — 协议矩阵(鉴权/白名单/控制开关, 独立实例)

- **动机**: smoke 把鉴权与白名单断言混在大场景里, 改协议时"哪条规则破了"不直观; SECURITY 承诺
  的"方法白名单是唯一真相"也需要一个逐条独立验证的矩阵。
- **新增** `bridge/test-auth.mjs`(9 条, 每规则一个独立 daemon 实例): 错令牌→unauthorized 且
  daemon 存活; 协议版本不符→protocol_mismatch; 未鉴权 QUERY 被拒; **扩展身份发 QUERY→forbidden**
  (白名单: 仅代理可 QUERY, 扩展发 QUERY = 攻击者); 控制方法未开 `--allow-control`→错误带开启方式;
  正确配置→ready。
- **两个真实认知**(踩坑换来的): ①hub 对 QUERY 的控制白名单判定**在扩展在线判定之后** —— 测试⑤
  必须先挂假扩展, 否则先行被"扩展未连接"拦下, 断言方向错; ②相对路径 spawn 在仓库根跑时 ENOENT
  (与 R1 的 smoke 同款教训, 已统一绝对路径)。

## v1.1.55 — 桥接客户端重连语义(行为级)

- **缺口**: hub 侧(bridge)的重连有单测, 但**扩展侧**(bridge-client.js)的重连语义零覆盖 ——
  连接失败/断线恢复/心跳/alarm 生命周期, 坏了只能靠真机发现。
- **新增** `bridge/test-reconnect.mjs`(10 条, vm 跑真实 bridge-client.js + 可控 FakeWS):
  失败 → lastError 有值 + **alarm 重连**(setTimeout 在 MV3 worker 休眠后不触发);
  READY → connected; daemon 断开 → 重新 alarm + connected=false;
  恢复 → lastError 清空; hello 帧含令牌与协议版本。
- **踩坑三连(全是测试自己)**: ①status() 是 **async 方法**(含 await), 不 await 拿到的是
  Promise(`{}`); ②R58 的 ok 参数反序教训**又犯了一次**(9 处, 输出 "OK false" 即假绿信号);
  ③未喂 ready 时 connect 永不 resolve, 后续段静默退出 —— fire-and-forget + 手动喂帧。
- **教训固化**: 本文件在断言库签名旁写明"参数反序=最危险假绿", 并把 status() 异步形态
  写进接口注释。

## v1.1.54 — verdict 判定矩阵走查

- verdict 是链路重放的"裁判"(每条 OK/DIFF/FAIL/ERR 直接决定下一步)。此前
  check_replay_smoke 只覆盖引擎级语义, **判定矩阵的组合边界**(尤其"断言优先于状态码"
  这条隐含契约)没有独立对照 —— 改 verdict 时容易破坏它。
- **新增 19 条断言**: ERR 双入口(null / status=0); 断言优先(500→200 + contains 通过 → OK,
  失败时 msg 标"业务断言"); 四类断言正反例; json_eq 三条降级(非 JSON→失败不炸、
  路径不存在→失败、数组取首元素); 无断言回退(全文一致 OK / 状态码优先于 body /
  体差异 DIFF 不是 FAIL); 快失败(msg 报第一条)。

## v1.1.53 — REVIEW.md 归档压缩(58KB → 28KB)

- REVIEW.md 是过程日志, 34 段里 R1-R20(20 段)占 57% 字节, 而它们的根因、修法与证据
  已经沉淀到 CHANGELOG、测试文件注释与闸门本身 —— 留着的价值只剩"考古"。
- 压缩规则: R1-R20 每段压成**一行索引**(标题 + 首条要点), 归档说明写明全文在 git 历史;
  R21+(近段, 决策上下文仍有价值)保留全文。门禁块与"下一轮候选"不动。
- 完整过程从未丢: 上一个 commit(6d6063b)及之前的 git 历史里都是全文。

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
