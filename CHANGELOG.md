# 更新记录

## v1.1.71 — 注释形态的 assert.<method>() 逃过放行检测

- **注入矩阵(规则 2 续审)**: 11 种放行形态里检测面覆盖 7 种(注释 ok / .skip / .todo /
  xit / xdescribe 等全部红), 但 `// assert.equal(...)` / `// assert.ok(...)` ——
  **注释掉的 assert 方法调用**漏抓。根因: A 检测的正则要求 `assert` 后直接 `(`,
  而 assert 的实际调用形态是 `assert.xxx(`。
- **修**: 正则允许 `.`(\s*\(|\.\w+\s*\() 形态; 自证段同步。
- **复核**: 注入 `// assert.equal` + `// ok()` 双形态都红; 清洁态绿。
- 恒真断言(ok(true)/1===1/if(false) 包裹)属**语义级放行**, 静态检测无从下手 ——
  这正是"断言必须能区分新旧"由各闸门自证段承担的原因, 不在本检测面内(如实标注, 不装覆盖)。

## v1.1.70 — 规则 3 的闸门被"修假阳性"修成了瞎的

- **注入实证(R82 方法的延续)**: 对规则 3(禁止全量 add)试四种真实形态 —— 行首裸命令、
  **引号内字符串**、`--all`、`-u`、Markdown 列表项 —— **5/5 全部漏抓**。连字面量形式的
  全量 add 写在字符串里都过(即: 禁止全量 add 这条规则实际无人执行)。
- **两个根因(都是 R56 修假阳性时引入的)**:
  1. 正则要求前置是"行首或空白"(`(^|\s)`), 引号/等号/列表符后面的用法全漏;
  2. 注释豁免把**任何以 `-` 开头的行**当注释 —— Markdown 列表里的真实命令行被当注释放过。
  另外禁用集缺 `--all` / `-u`。
- **修**: 前置条件放宽为"非标识符字符"(`(?<![\w-])`), 禁用集补 `--all`/`-u`, 注释豁免收紧到
  真正的注释语法(`// * /* # >`), Markdown 列表不再豁免; 断言消息本身改写避免自匹配。
- **双向验证**: 6 种违规形态全部红(含引号内与列表项), "文档里描述禁令"的句子仍绿(不误报)。
- **教训**: 为消除假阳性而放宽检测, 如果没配"负向验证", 会把闸门修成瞎的 ——
  **修假阳性后必须立刻证明它还能抓真的**。

## v1.1.69 — 规则-闸门矩阵审计: 补上"永远全录"这条唯一裸奔规则

- **审计方法**(本轮产的: 不再靠"关键字命中"判定规则有闸门, 而是**逐条制造违规看谁红**):
  对 AGENTS §1 的 7 条 Never 逐条注入违规 —— 规则 1(加 package.json / import 第三方)、
  规则 4(写入真实内网域)、规则 6(manifest 加 `*://*/*`、写死域名)全部**当轮变红**;
  **规则 7(录制永远全录)全绿** —— 在完成路径插 `if (item.status !== 200) return;` 丢弃
  非 200 条目, 73 个闸门无一报警。
- **新增** `test/check_record_all.js`(9 条): 状态码四形态、mime 四形态(text/html、
  image/png、text/event-stream、空)、超长体(截断到 200000 但条目在)、空响应(204)、
  loadingFailed 不入库、非授权域不入库 —— 全部落在"库里有什么", 不看显示层。
- **负向验证**: 注入"丢弃非 200" → 新闸门 4 条红(状态码只剩 200、累计 8→5、204 缺失);
  恢复后绿。AGENTS §1.7 补上闸门指向(时间序 → check_engine_edge 场景 1)。

## v1.1.68 — 工具参考丢失共享过滤参数(CRLF 末行解析 + 展开缺失)

- **实证缺口**: `net_list`/`export_har`/`export_jmx`/`export_python`/`chain_replay` 五个工具
  共用 `filterShape`(method/status/statusMin/statusMax/pathIncludes/hostIncludes), 而
  tool-reference 里这五个工具的过滤参数只有**一行占位** `...filterShape` —— 用户按
  mcp-clients.md 的指引去查参数却查不到字段名。
- **两个根因**:
  1. 生成器解析共享形状时用 `split(/\r?\n/)` 逐行匹配 `^\s{2}name:` —— **末行没有 `\n` 可切,
     残留的 `\r` 让 `$` 锚失效**, 每个形状的最后一行(`hostIncludes`)被静默丢掉。这是
     "CRLF 必须剥 \r"教训的又一个变体(此前只防了 ```split``` 场景)。
  2. 更早的实现干脆不展开共享形状, 只写占位行。
- **修**: 逐行 `replace(/\r/g,"")` 后解析; spread 时把形状字段展开成真实参数行(带类型与
  说明); `check_tool_reference` 补"共享形状字段必须全部出现在文档里"守恒断言。
- **负向验证**: 把展开改回占位 → 闸门红, 列出 `missing:[method,status,statusMin,statusMax,
  hostIncludes]`; 恢复后绿。

## v1.1.67 — tool-reference 补齐同族盲区(条目数守恒)

- **对称排查**: R79 在 skills.md 发现"生成器正则漏项 + 逐字节闸门两侧同漏"后, 回头查
  tool-reference 生成器 —— 同样用窄字符类 `register\("([a-z_]+)"` 抽工具名。当前 27 个
  工具全为小写下划线,**尚未漏**, 但未来任何驼峰/连字符工具名会被静默丢掉。
- **修两处**: ①生成器正则放宽为 `([^"]+)`; ②`check_tool_reference` 补
  "文档 ### 工具数 = tools.js register 数"守恒断言(与 skills 那条同铁律)。
- **负向验证**: 把生成器正则故意改窄成 `(page_[a-z_]+)` → 文档只剩 10 个工具, 闸门红并给
  `{regCount:27, docTools:10}`; 恢复后绿。**断言能区分新旧才算数**。

## v1.1.66 — docs/skills.md 漏掉第十项(生成器正则不认驼峰)

- **实证缺口**: README 与 skills.md 都写"十项技能", 而 skills.md 表格只有 **9 行** ——
  生成器正则 `name:\s*"([a-z_]+)"` 只认小写+下划线, 第 10 项 **`diffTriage`(驼峰)**
  被静默漏掉。
- **闸门盲区(本轮最有价值的发现)**: `check_tool_reference` 原本只做"生成产物 vs 入库文件
  逐字节比对" —— **两侧同漏就全绿**。已补独立断言: 数 skill.js 的 name 字面量条目数,
  与产物表格行数比对。**负向验证做过**: 把生成器改回窄正则, 闸门立刻红并给出
  `{srcCount:10, docCount:9}`;恢复后绿。
- **修**: 生成器正则改 `[\w-]+`(认驼峰与连字符), 重生文档至 10 行, 补上 diffTriage 行。
- **教训归档**: "同源生成 + 逐字节比对"只能防手改, 防不了**抽取器自身漏项**;
  凡生成式文档, 闸门必须另有"条目数守恒"断言。

## v1.1.65 — doctor --help(此前被忽略直接跑检查)

- **问题**: `doctor --help` 与 `-h` 都被忽略、直接跑 18 项检查 —— CLI 最基本的约定被破坏,
  用户想看用法却得到一堆 PASS/FAIL(还可能 exit 1)。
- **修**: doctor.js 参数解析后加 help 分支(打印用法与全部选项含 --flag=value 提示, 退出 0);
  test-doctor 新增 3 条: --help/-h 退出 0、打印用法含选项、**不跑检查**。
- **顺带核查**: index.js 帮助文本已含 archive 两项(v1.1.29 加过), 无需补。

## v1.1.64 — 提速收尾: 剩余慢套件定性 + unit race 兜底收紧

- **R75/R76 方法的收尾**: 对剩余 5s+ 套件逐一 sleep 扫描定性 ——
  - **reconnect 5.4s**: 显式等待仅 390ms(8 处 30-50ms), 其余是 4 段 vm 编译
    bridge-client.js(固有成本, 每段要干净状态) + FakeWS 节奏 —— **无浪费, 不动**;
  - **unit 5.7s**: 71 断言全是真实逻辑, 唯一可收的是 hub 断线广播 race 的 2000ms 兜底
    (事件驱动实测 <100ms) → 600ms, 省 1.4s。
- **总账**: 三轮提速 doctor 12.6→6.9 / smoke 10.7→8.2 / unit 5.7→5.8(微降但去掉了
  大兜底), 全部在"不牺牲断言真实节奏"的前提下。

## v1.1.63 — smoke 提速(10.7s → 8.2s, 就绪探测化)

- **方法沿用 R75**: sleep 分类(就绪等待 vs 行为节奏), 只动前者。24 处 sleep 里 8 处
  `起 bridge 后 700/1200ms` 是就绪等待 —— 全部换成 `waitPort(PORT)`(TCP 探测, 60ms 节拍);
  10.7s → **8.2s**(-23%), 74/74 全过。
- **保留的(故意不动)**: kill 后 200ms×7(Windows 端口回收必须给足); mcp.init 后 300/500ms
  (客户端初始化时机无事件面, 探测化风险>收益); connectRetry 内 150ms 节拍(它本身已是探测)。

## v1.1.62 — doctor 套件提速(12.6s → 6.9s)与教训

- **量化**: 12 个最慢 suite 实测排序 → doctor 5.65s 挤进前三; 睡眠扫描发现 4 处
  `sleep(1800)` 共 4.2s 纯等。
- **两步修**: ①固定 1800ms → 就绪探测(daemon 实测 420ms 就绪, 不必等满 1.8s);
  ②正确令牌与错令牌两个 case **共用一个 daemon**(冷启动只付一次), 21→22 断言全过,
  12.6s → **6.9s**(−45%)。
- **教训一(本轮最大成本)**: 用脚本点改带正则的断言行, 转义层叠出 5 轮红
  (双反斜杠进正则字面量→非法 flag; 后续清理脚本又把本来就对的 ok(cond,msg) 反写成
  ok(msg,cond))。**带正则/模板的代码不做机械点改, 整段重写**。
- **教训二**: 探测循环里 connect() 的 4s 超时会吞掉节拍收益 —— race 500ms 快速失败。
- smoke(10.7s)是下一个大头, 但它的 26 处 sleep 测的是行为节奏, 压缩要逐处评估, 另轮做。

## v1.1.61 — zip 压缩(448KB → 173KB)

- pack.cjs 从 store 切 **deflate(level 9)**: 源码文本类内容实测 -61%~-67%(376KB→139KB),
  zip 总体 448KB → **173KB**。真实 `Expand-Archive` 展开 + 8 文件字节对拍通过。
- **两个 zip 结构 bug(打包器自纠)**: ①central directory 的 method 字段(offset 10)没改,
  解压器按 CD 决定算法 → 把压缩流当 store 落盘(展开产物是乱码); ②内置自检跳条目用
  uncompressed size 去 skip, deflate 后跳过头丢条目(22 误报 8)。两个都修后自检 + 真实
  展开 + 字节对拍三层全过。

## v1.1.60 — 一条命令打包(bridge/pack.cjs)

- **动机**: 用户装扩展要手动挑文件(排 test/samples/bridge/docs), 挑错就装不上或带脏东西。
- **实现**: `bridge/pack.cjs` —— 纯 Node(zlib + 手写 zip 结构, 零依赖)。**白名单**收集:
  manifest + 根 js(**排除 `test_*`/`*_test.js`**)+ popup/sidepanel/options/icons 四目录。
  产出 web-toolbox.zip(22 文件, 448KB)。自检内置(读回 zip 验 manifest 在、无违禁路径);
  真实 `Expand-Archive` 展开复验通过(22 文件、零 test 混入)。
- **首包踩坑**: 根目录 ".js 全收"把 test_regression.js / mock_bg_test.js 打进去了 ——
  排除规则与 test/ 目录同口径(`test_*` 与 `*_test.js` 都算测试)。
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
