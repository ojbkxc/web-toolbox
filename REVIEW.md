# 评审记录 —— 对标 chrome-devtools-mcp

参照: `E:\github\chrome-devtools-mcp-main\chrome-devtools-mcp-main`(Chrome DevTools MCP, TS + puppeteer)。
目标: 持续评审并完善本仓库; 每轮必须"取证 → 修根因 → 回归 → 记录", 不许只写结论。

**门禁(2026-11-23 起)**
- 扩展回归: `node test/run_all.js` → **67/67 PASS**(内含桥接 unit/exporters/doctor/smoke)
- 桥接端到端: `node bridge/smoke.mjs` → **74 PASS / 0 FAIL**(任意 cwd)
- 桥接单测: `node bridge/unit.mjs` → **71 PASS / 0 FAIL**; `node bridge/test-exporters.mjs` → **46 PASS / 0 FAIL**
- 桥接自检: `node bridge/src/doctor.js` → **18/18 PASS**(需先起 daemon; 含监听地址/活体握手/协议与包版本一致性/归档目录/令牌权限)

---

## R35-R48 · v1.1.38 (2026-11-23)

### R35(续): 推送 + 门禁确认

- 用户授权推送: commit `9ef1875`(38 文件, +966/-223)推到 `origin/main`, 本地/远端 SHA 一致;
  仓库**无 Actions workflow**, 等价门禁就是本地走查(推送前 59/59)。提交信息按口径写根因。
- R36-R47: 模型切换空窗(无模型输出), 无产物。

### R49: tab_list 结构化(结构化工具覆盖面到 7/27)

- `tab_list` 与 `net_hosts` 同款: 返回值是数组, `structuredContent` 用 `{total, tabs}` 包裹,
  `content` 保持原数组(兼容既有调用方); 非数组时抛 `bad_payload`(与 net_list/net.hosts 同口径)。
- **闸门先红后绿的自证**: `check_tool_table` 立刻抓到"工具表没标 ✓" —— 这正是这张表的价值
  (实现改了、文档忘了改, 当轮就红)。补表行后绿。
- smoke +1(52), `check_bridge_schema` 的"七个机读工具"断言同步更新
  (bridge_status/net_list/net_get/net_hosts/correlate/tab_list/chain_replay)。

### R58: 13 个工具"零测试提及" → 全部补上行为级覆盖

- **实测缺口**(按工具名扫全部测试源): 27 个 MCP 工具里 **13 个从没被任何测试提到** ——
  `rec_start`/`rec_stop`/`tab_navigate`/`page_type`/`page_press`/`page_hover`/
  `page_select`/`page_scroll`/`page_wait`/`tab_activate`/`tab_close`/`page_screenshot`/`page_eval`。
  工具表只证明**存在**, 没人证明"工具 → 协议 → 扩展"三段是通的。
- **补**: smoke 新增 `[8] 控制类工具全覆盖`(在 `--allow-control` 环境真调 15 个工具, +14 条断言),
  断言到"透传"层面: `rec_start.tabId=42`、`tab_navigate.url`、`page_type` 的
  `text/submit/keyByKey`、`page_select` 的 `ref/value`、`page_scroll.deltaY`、`page_eval` 的 `script`、
  `page_screenshot` 返回 `image` content(不走 JSON)等。
- **新增** `test/check_tool_coverage.js`(闸门 + 2 条自证): 每个工具都必须在 smoke 里出现真调用形态
  (`callTool(`/`call(`/`J(`), **注释行与纯文档提及不算**; 另验 "--allow-control 启动分支存在"
  (否则控制类只测了 forbidden 分支)与"无幻影调用名"。
- **踩坑(两次假绿, 都是自己的错)**:
  1. 本节 `ok(...)` 参数顺序写反(`ok(msg, cond)`, 而 smoke 签名是 `ok(cond, msg)`)—— 断言恒真,
     输出 12 行 "OK true"。**这是最危险的一种错**: 看起来全绿, 实际什么都没验。
  2. 覆盖判定最初用"禁注释正则", 对**行内注释**仍判真; 改成逐行 `line.split("//")[0]` 后再判
     才把注释形态排除掉 —— 自证里那条 `ghost_tool` 就是专门抓这个的。
- 工具覆盖面从 14/27 提升到 **27/27**(行为级)。

### R57: AGENTS 硬规则 2/3/1 的机器执行(补上最后三条"纪律")

- **动机**: 到 R56, 硬规则 1/4/5/6/7 各有闸门; 剩下 2("禁止在测试里放行未过的断言")、
  3("禁止全量 add")、以及 1 的零依赖正向检查一直是**纪律**。纪律靠人记就会破。
- **新增** `test/check_repo_rules.js`(7 条判定 + 5 条自证):
  - A 测试里不许出现**被注释掉的断言调用**;
  - B 不许框架级跳过调用 —— 但 `TC.skip(...)` 合法: 它打 `SKIP(env)` 并计入摘要, 正是
    AGENTS "环境限制用 skip 标注, 不伪装通过"的形态;
  - C `process.exit(0)` 只允许在文件末尾(提前退出会让后面断言静默不跑); 判定排除注释行与
    写在字符串/正则里的自描述;
  - D 脚本/文档里不许出现全量 add 用法(注释行豁免: 写"禁止…"是要求不是用法);
  - E 零依赖: 仓库根无 `package.json`、manifest 无打包字段、**扩展运行时代码不引第三方 npm 包**
    (只扫根 js + 三页面; `node:` 前缀与内置模块名不算)。
- **闸门自证(本轮最关键的工程决定)**: 探针用**拼接构造**写成数据, 而不是按字面量写在文件里 ——
  否则闸门会抓到自己。这一步逼出一个真问题: 闸门必须能区分"**描述规则**"与"**使用形态**",
  于是 B/D 都加了注释行豁免, 并用五组探针证明豁免没把真形态一起放过。
- **踩坑(3 次红)**: 探针最初直接写了被禁形态的字面量, 闸门立刻抓自己; 改拼接后才绿 ——
  这本身证明闸门**真的在工作**, 不是恒真。

### R56: "永远全录"从注释变成行为级断言(AGENTS 硬规则 7)

- **规则原文**: "录制永远全录(过滤/勾选/清洗只影响显示与导出)"。此前这条只写在 AGENTS 与
  `background.js` 注释里 —— **没有任何一条测试喂过静态资源/OPTIONS/SSE 进引擎**。
- **新增场景 9**(6 条, 走真实 flushEntries 管线): `.css`/`.js` 入列(9a); OPTIONS 预检入列(9b);
  SSE(`text/event-stream` mime)入列且保留 mime(9c) —— 若引擎按 mime 剔除, 导出层的 SSE 判定
  就永远不被触发; 普通业务入列(9d); **未授权域不入库**(9e); 未授权域**计入 unmatchedHosts**
  (9f, 走 `getRecInfo` 读 `["other.example.net×1"]`) —— 不入库但必须"可见"。
- **踩坑**: 状态消息名是 `getRecInfo` 不是 `getState`; 写错时断言拿不到 unmatched 就红,
  说明这类"名字写错"也能被行为测试抓住而不是静默通过。

### R55: 清掉三处注释里的真实客户域名 + 域名闸门(含自证)

- **实测发现**(AGENTS 硬规则 4 "禁止把真实内网域名写进任何入库文件"): 三处**注释**里残留真实
  客户域名 —— `sidepanel/sidepanel.js`(漏录示例)、`popup/popup.js`(域名覆盖示例)、
  `jmx.js`(跨环境切法示例)。代码逻辑没用到, 但注释同样入库、同样会被人复制到别的文档里。
- **修**: 换成 RFC 2606 保留域(`example.com` 系), 语义不变(仍是"父域覆盖子域"的示例)。
- **新增** `test/check_no_internal_domains.js`: 扫扩展运行时代码(21 个文件), 三类白名单各自带理由 ——
  保留域(RFC 2606/6761)、产品自有域(`lxseek.com`, 选项页要告诉用户去哪买 Key)、
  以及扩展 API 命名空间误捕(`chrome.storage.local`)。
- **闸门自证**: 另跑两组样例证明闸门有效 —— 真实域样例(midea 系、corp.internal)必须判红,
  保留域/产品域/命名空间必须放过。只看"0 命中"不够: 正则写坏时也是 0 命中。
- 范围说明: `samples/` 是脱敏样本库、`test/` 是测试数据, 由它们各自的规则管, 不在本闸门判。

### R54: AI 外发路径单源闸门(AGENTS 硬规则的机器执行)

- **AGENTS 写着**"数据卫生管线不可绕过", 但规则要能被执行才算规则。实测确认了现状是好的:
  10 个 `build*Prompt` 全在 `aireport.js` 且**每个内部都自带清洗**; sidepanel 6 个 AI 入口
  一律 `build*Prompt` → `callLlm`, 没有旁路拼 prompt。
- **但这条性质没人钉**: 新增一个忘清洗的 `build*Prompt`, 或新增一个直接拼 messages 调
  `callLlm` 的入口, 现有测试(清洗规则 / try-catch 守卫 / prompt 一致性)都不会红。
- **新增** `test/check_ai_egress.js` 七条: 每个 build*Prompt 自带清洗、每处 callLlm 的宿主
  经 build*Prompt、build*Prompt 单源(别处不许复制)、skill.js 委托 aireport 且**不自己再洗一遍**
  (防双份规则漂移)。
- **白名单要能自证**: 唯一例外是选项页 `testLlm`(只发固定探测文本验证地址/Key 可用, 不碰 harvest);
  另有断言校验"白名单例外函数体里不出现 entries/harvest/exportRows" —— 一旦例外开始夹带条目,
  白名单立刻失效报警。
- SECURITY.md 补一段"单源可验证", 把这条从实现细节提升成对外承诺。

### R53: doctor 端到端(21 条) —— 排障承诺必须有运行时证据

- **动机**: `doctor` 是"连不上时第一个该跑的东西", 它的检查项、顺序、文案都是**排障承诺**。
  此前只有静态断言(字符串在文件里), 证明不了"运行时真查了、失败时真红、失败时还跑得完"。
- **新增** `bridge/test-doctor.mjs`(真起 daemon, 只看 stdout 与退出码), 四场景 21 条:
  1. **无 daemon** → 端口项 `[FAIL]` + 给出下一步, **其余检查仍跑完**(不是半路退出),
     末尾有汇总; 且此时**不做活体握手**(不连坐出第二处红);
  2. **有 daemon + 正确令牌** → 退出码 0, 端口/令牌/活体握手/协议一致/包版本一致/归档可写
     六项逐个 PASS, 汇总 `doctor PASS: N/N`, 且有"归档保留期/归档体积"两行 INFO;
  3. **有 daemon + 错令牌** → 退出码 1 且**恰好 1 项**红(令牌活体), 原因含 `unauthorized`
     —— 端口/协议/版本不许被连坐;
  4. **参数错误**(--port 0) → 退出码 2 + 一行明说"1..65535" + **不甩栈**。
- **接入**: `test/run_all.js` 增加 `bridge-doctor` suite(60/60); `bridge/package.json`
  的 `npm test` 聚合里加入; 文档计数闸门按设计先红(59→60), 同步后绿。
- 顺带修: `run_all` 与 `check_doc_counts` 的 SKIP 提示原来只列 3 个桥接 suite, 补齐到 4 个。

### R52: net_list 字段过滤边界(9 条)+ 口径澄清

- **动机**: `applyFilter` 是 `net_list`/`export_*`/`correlate`/`chain_replay` 四处共用的筛选器,
  之前只有 "limit/offset/无命中" 的边界(R14), **多条件组合与 hostIncludes 的前缀陷阱**没人钉。
- **新增 9 条**(4 条数据: status 200/500/404/302 + `api.test.com` 与 `api.test.com.cn` 两域):
  method 大小写不敏感精确匹配、status 数值精确、statusMin、statusMax、statusMin+Max 区间、
  method+statusMin 的 **AND** 语义、**`hostIncludes` 是子串匹配**(会跨域命中 `api.test.com.cn`)、
  pathIncludes 路径子串、无命中时仍给 `total/filtered`(不报错)。
- **口径澄清写进 bridge README**: 侧栏搜索框是"关键词分词 AND"(人搜词), bridge 是字段级过滤;
  两者**不是同一个东西** —— 尤其 `hostIncludes` 的子串语义要写明, 否则会以为它按域精确匹配。
- **自查踩坑**: 首版把 `statusMin≥400` 的期望写成 3 条(实际 500/404 两条), 被断言当场抓出 ——
  手算期望值必须让测试自己说话。

### R50: 提交并推送(经授权)

- commit `8172480` 推到 `origin/main`, 本地/远端 SHA 一致(`9ef1875..8172480`);
  仓库仍无 Actions workflow, 等价门禁为本地 59/59。

### R51: 导出产物体积守卫(实测 3000 条会造 6.7MB 脚本)

- **实测**: 500 条抓包 → JMX **1139KB** / HAR **912KB** / PY 497KB; 线性外推到 3000 条(录制上限)
  约 **JMX 6.7MB / HAR 5.3MB** —— 直接塞进 MCP 响应会撞客户端体积上限或 OOM。
- **关键判断**: 脚本类产物(HAR/JMX/PY)**截断即废** —— 半截 JSON 不是 HAR, 半截 JMX 打不开。
  所以既不返回半截, 也不静默截断, 而是**明确失败并给出路**(与 errors.js 的失败口径一致)。
- **实现**: 新增 `guardExportSize()`; 三个导出工具加 `maxChars`(默认 2,000,000, 上限 20,000,000);
  超限返回 `错误[bad_state]: <工具> 产物过大: 当前 N 条会生成 M 字符(约 X MB), 超过上限 L` +
  "下一步"里给**具体可执行**的三条缩小路(按域名 `hostIncludes` 并列出真实域名 / 按路径前缀
  `pathIncludes` 并列出真实前缀 / `statusMin` 只看失败)以及 `maxChars=<建议值> 调高上限`。
- **验证(smoke +6, 52→58)**: 40 条 × `maxChars=1000` → isError + 机读码 `bad_state` + 文案点名
  工具与上限 + 下一步含 `maxChars=` 与 `statusMin/hostIncludes`; 对照组(默认上限导 40 条)正常返回。
- 顺带: `errors.knownCodes()` 之前是零引用导出, 现在被 `check_bridge_errors` 用来断言
  "knownCodes() = 线协议码 ∪ 业务码"(少一个码 = 有码查不到文案)。

### R48: chain_replay 汇总结构化

- **问题**: `chain_replay` 的汇总只存在于 `content` 文本里(人读的 "OK 3 · DIFF 1"), 客户端要
  判断"这条链是不是全绿"还得 parse 文本 —— 而它恰恰是 AI 改完代码后**必看**的那个数。
- **改法**: 补 `outputSchema` + `structuredContent`: `{total, summary, verdicts[{verdict,count}],
  failed[...], results[...]}`。`summary` 仍给人读, `verdicts/results` 给机读。
- **踩坑**: 首版 smoke 给假扩展喂 `ids: ["q0","q1"]`, 但 `serveExt` 的 handler 没接
  `chain.replay` 分支 → 回 `__err` → 测试误红; 补上分支(返回一条 OK 结果)后绿。
- smoke +2(51 项), schema 闸门仍 PASS(`structured()` 与 outputSchema 成对自动生效)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 59/59 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **51/51**(+2) |
| schema/errors 闸门 | `check_bridge_schema` / `check_bridge_errors` | PASS |

### 下一轮候选(不变)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等批**: 响应头落库(录制引擎 CDP responseReceived 分支, ask-first)。
3. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。

---

## R33-R34 · v1.1.37 (2026-11-23)

### 页面接线闸门(JS 引用的 id 是否真的存在 / 有无重复 id / tab 面板指向对不对)

- **动机**: 侧栏/弹窗/选项页都是"纯手工接线" —— JS 里 `$("xxx")` 拿不到元素时, 运行期是
  `null.classList` 直接抛("点了没反应"且控制台才有线索); HTML 里 id 重复时 `getElementById`
  只回第一个, 另一半按钮永远是死的。这两类故障都没有任何静态防线。
- **新增** `test/check_ui_wiring.js`, 对三对 (html, js) 各做四条:
  1. JS 里 `$("literal")` / `getElementById("literal")` 的 id 必须存在于
     **HTML 静态 id ∪ JS 模板里声明的 id** —— 侧栏详情面板是 innerHTML 拼的(`dResp`/`dBody` 等
     只在 JS 里), 只看 HTML 会大面积误报;
  2. **拼接形态不参与判定**: `$("pg" + tab)` 这种参数不是单字面量, 静态枚举不出
     (首版把 `"pg"` 当成缺失 id → 误红; 实际是 `pgExp/pgCk/pgRec/pgPage/pgLog` 的前缀);
  3. HTML 内 id 不得重复;
  4. `role="tab"` 的 `aria-controls` 必须指向真实面板; 形如 btn*/input/select 的控件不得
     "既无 JS 引用也无内联事件"(绝对死件)。
- 实测: sidepanel 98 个引用 / 84 个 HTML id(含 JS 模板后共 112 个声明)全绿; popup 17、options 15 全绿。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **59/59 PASS** |
| 接线闸门 | `node test/check_ui_wiring.js` | PASS(12 条) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等批**: 响应头落库(录制引擎 CDP responseReceived 分支, ask-first)。
3. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。
4. **接线闸门延伸**: 侧栏事件委托(`data-*` 属性)与按钮 aria-label 的一致性可再加一层。
5. **只读注解收益验证**: 找 Claude Code 侧配置样例。

---

## R32 · v1.1.36 (2026-11-23)

### background 侧"桥接自发 detach 不清录制状态"守卫(补 R31 的另一半)

- **背景**: R31 钉住了桥接侧(会用 `globalThis.toolboxBridgeOwnDetach` 打标记); 本轮钉
  **background 侧是否真的看这个标记** —— `background.js:179` 的 onDetach 监听里有一句
  `if (own && own.has(src.tabId)) return;`, 此前没有任何断言。漏了它, AI 点一下页面就会把录制
  静默清掉(用户只看到"录制中却抓不到")。
- **新增** `test/check_bg_detach_guard.js`(vm 跑真实 `background.js`, chrome 用**递归包裹的宽松
  Proxy** stub), 4 个场景:
  1. 标记含该 tabId → **detach 0 次、不写 storage**(录制状态完全不动);
  2. 标记不含(用户点黄条取消/被别处抢走) → 真的 `chrome.debugger.detach` 并清 attach 记录;
  3. 标记不存在(桥接未加载) → 不抛错, 仍按真实 detach 处理;
  4. 事件不带 tabId → 不炸。
- **踩坑三连(全是 harness 问题, 不是产品问题)**:
  1. 不能把 `common.js` 与 `background.js` 塞进同一个 realm —— 同名 `KEY_DOMAINS` 直接
     SyntaxError, 这正是"SW 里绝不 importScripts common.js"那条约束的现场复现;
  2. 宽松 Proxy 必须**递归包裹** overrides, 否则 `chrome.runtime.onInstalled` 这种二级属性是 undefined;
  3. Proxy 的 `get` 里"兜底 addListener"必须放在"显式 overrides"**之后**, 否则捕获监听器的自定义
     `addListener` 被覆盖, 断言永远看到 null。
- 另外把断言从"有没有写 storage"改成 **`chrome.debugger.detach 调用次数** —— detachTab 只在
  tabs 列表里存在该 tab 时才写 storage, 直接数清理动作更稳。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **58/58 PASS** |
| detach 守卫 | `node test/check_bg_detach_guard.js` | PASS(4 场景 5 断言) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等批**: 响应头落库(录制引擎 CDP responseReceived 分支, ask-first)。
3. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。
4. **同类不变量巡检**: `pending` 清理 / 环形诊断日志双上限 / 时间序入库是否也有"只在注释里"的约束。
5. **只读注解收益验证**: 找 Claude Code 侧配置样例。

---

## R31 · v1.1.35 (2026-11-23)

### 桥接"借用 debugger"不变量: 从代码注释变成 13 条断言

- **为什么重要**: 同一 tab 只能有一个 `chrome.debugger` attach。录制引擎可能正 attach 着它,
  桥接若在收尾时无条件 detach, 就会把录制踹下来 —— 用户看到"录制中, 却什么都没录到",
  而日志里没有任何报错。这条不变量此前**只写在 `bridge-client.js` 的注释里**, 没有一条断言。
- **新增** `test/check_bridge_attach.js`(vm 里跑真实 `bridge-client.js`, `chrome.debugger` 全 stub
  并计数), 逐条钉住:
  1. 自己 attach 成功 → 用完 detach **一次**, 且 detach 时 `toolboxBridgeOwnDetach` 已挂上
     (否则 background 的 onDetach 会清掉录制状态);
  2. 录制引擎已 attach(`Another debugger is already attached`) → 功能照常可用, **detach 0 次**;
  3. 其它 attach 错误(如 tab 不存在) → **抛出**并指明"无法连接调试器", 不静默借用;
  4. detach 本身抛错(已被别处 detach) → 不影响结果, 但仍尝试一次;
  5. 标记不是立刻删, 1s 后才摘除(给 onDetach 留时间)。
- **顺带发现的口径差异**: 这条路径是 **throw** 而不是 `{ok:false}` —— MCP 层由 `run()/fromException`
  兜住, 侧栏由 `pageDispatch` 包装(见 `check_page_tab` c6); 测试里把这层差异写进注释, 免得
  下一个人以为"应该返回 ok:false"。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **57/57 PASS** |
| 借用语义 | `node test/check_bridge_attach.js` | PASS(13 条) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等批**: 响应头落库(录制引擎 CDP responseReceived 分支, ask-first)。
3. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。
4. **同类不变量巡检**: `background.js` 的 attach 记账 / pending 清理是否也有"只在注释里"的约束。
5. **只读注解收益验证**: 找 Claude Code 侧配置样例。

---

## R30 · v1.1.34 (2026-11-23)

### HAR 必填字段清单补全(解释 R29 为什么能"漏这么久") + doctor 归档日期跨度

- **为什么 R29 的 `content.size` 缺失一直没被发现**: `check_export_clean` 本来就有
  "HAR 1.2 required 字段齐"的断言, 但它的清单**漏了 content 的两个必填项**
  (`size`/`mimeType`) 与 `log.creator` —— 断言名字比它实际覆盖的面大, 于是少写一个必填字段
  时整轮回归仍是绿的。本轮把清单补齐:
  - `log.creator.name/version` 必须存在(缺了 HAR 校验器直接拒收);
  - `response.content.size` 必须是数字(缺则消费方按 0 汇总传输量);
  - `response.content.mimeType` 必须是字符串; `cache` 必须是对象。
- 这是"**断言名 ≠ 断言面**"的典型: 名字写着"required 齐", 实际只覆盖了 4/5。补完之后,
  下一个人再动 buildHar 漏字段, 第一次跑全量就会红。
- **doctor 归档日期跨度**: `[INFO] 归档日期跨度: 2026-10-22 → 2026-11-23(共 7 天)` ——
  体积看不出"还在不在写", 最新日期会停住, 一眼能判断 daemon 是否还在工作。仍是 INFO, 不改退出码。

### 附: 又抓到一处时序抖动(smoke [7] 固定端口)

- 本轮全量回归第 2 次跑时 `bridge-smoke` 红了 3 条(全是 [7] 控制开关不一致那组), 单独跑 3 次却全绿。
- 根因两条叠加: ①[7] 用的是**固定端口 9499**, 上一次跑没退干净的 daemon 还在听, MCP 进程就接到了
  旧 daemon(它的 `allowControl` 可能不是 false); ②靠固定 `sleep(1500)` 等 daemon 就绪, 负载高时不够。
- 修法: 端口改随机(`9500 + rand(400)`), 就绪改为**轮询握手**(最多 30×200ms), 拿不到就明确报
  `独立 daemon 就绪 → false` 而不是让后续三条一起误红。改完 smoke 连跑 3 次、全量连跑 3 次全绿。
- 教训(与 R26 同类): **测试里任何"固定端口 / 固定 sleep"都是假红源** —— 端口要随机、就绪要轮询。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS(修抖动前 1 红, 修后连跑 3 次全绿) |
| 桥接端到端 | `node bridge/smoke.mjs` | 49/49(连跑 3 次) |
| 导出净化 | `node test/check_export_clean.js` | PASS(+4 必填面) |
| 自检 | `node bridge/src/doctor.js` | 18/18 + 体积/日期跨度两行 INFO |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等批**: 响应头落库(录制引擎 CDP responseReceived 分支, ask-first)。
3. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。
4. **只读注解收益验证**: 找 Claude Code 侧配置样例。
5. **断言面巡检**: 可按同样方法扫一遍其它"名字大、覆盖小"的断言(如 aria/kv 块类)。

---

## R29 · v1.1.33 (2026-11-23)

### HAR `content.size` 按 UTF-8 字节补齐, 并把"有意留空"写进注释

- **缺口**: `common.buildHar` 的 `response.content` 只有 `{text, mimeType}` —— 缺 HAR 1.2 的
  `size`。Chrome DevTools / 其它 HAR 消费方会用 `size` 汇总传输量, 缺字段只能当 0。
- **改法**: 新增 `harByteSize()`(**UTF-8 字节数**, 与 bridge 侧 `reqBytes/respBytes` 同口径;
  中文 1 字符=3 字节, 用 `.length` 会低报 2-3 倍), 填 `content.size`。
- **同时把两处"有意留空"讲清楚**(它们看起来像漏写, 实际是引擎能力边界):
  - `response.headers` 恒为 `[]` —— 录制引擎只存**请求头**(CDP requestWillBeSent), 响应头从未入库;
    伪造一份空但"看起来完整"的头比留空更坏;
  - 二进制/Base64 响应在录制时已被替换成占位文本 `(binary/base64 略)`, HAR 里也是这段文本,
    **不**标 `content.encoding=base64`(那会让消费方把占位文本当 base64 解)。
- **断言两处同口径**: 根回归 `test_regression`(中文 2 字符 → size 6, `text` 不受影响)+
  bridge `test-exporters`(同一条中文样例走 bridge 的导出路径, 防两处分叉)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 根回归 | `node test_regression.js` | PASS(含 HAR size 两条) |
| 导出口径 | `node bridge/test-exporters.mjs` | **46/46**(+1) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本。
3. **响应头缺失**: 若要补 `response.headers`, 属**录制引擎**改动(需在 CDP responseReceived 落库),
   同样在 ask-first 范围 —— 需你决定是否做。
4. **只读注解收益验证**: 找 Claude Code 侧配置样例。
5. **doctor**: 显示最早/最新归档日期。

---

## R28 · v1.1.32 (2026-11-23)

### 方法/编码形态: PATCH、OPTIONS 预检、multipart 上传

- **动机**: R27 覆盖了 HEAD/空 body/204/超长 query; 还剩三类常见形态没断言 ——
  `PATCH`(改资源, 方法白名单里最容易被写漏)、`OPTIONS`(CORS 预检, **必须被清洗掉**, 否则压测脚本
  会给后端发一堆预检)、`multipart/form-data`(带 boundary 的原始体, 走"按原文重放"分支)。
- **新增 7 条断言**:
  - JMX: `OPTIONS` 被清洗(`/pre` 不出现)、`PATCH` 采样器方法与路径正确、multipart 走
    `postBodyRaw=true` 且保留 `filename=`(**不**伪造 `DO_MULTIPART_POST`, 与扩展侧导出同源);
  - PY: `OPTIONS` 同样清洗、`PATCH` 走 `sess.request("PATCH", ...)`、multipart 的
    `Content-Type`(含 boundary)原样保留、非 JSON 体按 `data=payload.encode("utf-8")` 原文发送。
- 这批断言的价值在"清洗边界": 预检被当成业务请求会让压测结果虚高, 而 multipart 被当成 JSON 会直接
  让脚本跑不起来 —— 两种错都很隐蔽。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 导出口径 | `node bridge/test-exporters.mjs` | **45/45**(+7) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **等定**: JMX 超长 query 是否额外产出 `Arguments` 版本(现在只有 path 形态)。
3. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
4. **doctor**: 显示最早/最新归档日期。
5. **导出器**: gzip/deflate 响应体与二进制响应的 HAR `content.encoding` 形态尚无断言。

---

## R27 · v1.1.31 (2026-11-23)

### 导出器的"异常形态条目"(HEAD / 空 body / 204 / 超长 query)

- **动机**: 真实抓到的流量不止 GET/POST+JSON。HEAD 没有响应体、POST 可能没有 body、204 没有正文、
  query 可能三十个参数 —— 这些分支此前**一条断言都没有**, 导出器一改就可能静默错。
- **新增 9 条断言**(构造 4 条边界条目, 直接喂 HAR/JMX/PY 三个导出器):
  - HAR: 保留 `HEAD` 方法、204 无正文时 `content.text` 为空串、超长 query 原样留在 url;
  - JMX: 4 条都出采样器、保留 `HEAD`、空 body 不生成 `postBodyRaw`、**超长 query 原样进
    `HTTPSampler.path`**(口径: 不拆成 Arguments, 保证 URL 与录制完全一致);
  - PY: 生成 4 个 step、`HEAD` 走 `sess.request("HEAD", ...)`。
- **修正过程(3 次预期错, 全是"我以为"而不是产品 bug)**:
  1. 以为 query 会拆成 30 个 `Argument.name` —— 实际原样拼进 `HTTPSampler.path`;
  2. 以为 PY 用 `requests.head(...)` —— 实际统一走 `sess.request("HEAD", ...)`;
  3. 以为 path 里是裸 `&` —— 实际 XML 转义成 `&amp;`。
  这三条都改成按**真实产物**断言, 并把口径写进注释(下次有人想"顺手拆参数"会被这条钉住)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 导出口径 | `node bridge/test-exporters.mjs` | **38/38**(+9) |
| 桥接单测/端到端 | `node bridge/unit.mjs` / `smoke.mjs` | 62/62、49/49 |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **doctor**: 显示最早/最新归档日期。
4. **PY 导出**: HEAD/DELETE 之外的 PATCH/OPTIONS 方法覆盖, 以及 `files=` 上传形态。
5. **JMX**: 超长 query 是否该同时给 `Arguments` 版本(现在只有 path 形态) —— 属产品决策, 需你定。

---

## R26 · v1.1.30 (2026-11-23)

### `--flag=value` 等号写法 + doctor 预演"这次会删哪些归档"

- **等号写法**: 带值参数(host/port/token/token-file/archive-dir/archive-keep-days)支持
  `--port=9280`、`--token=abc==`; 只在这些已知 flag 的**第一个 `=`** 处切分, 值里允许再出现 `=`
  (令牌/路径常见); 未知的 `--foo=bar` 仍报"未知参数"而不是被当成值吞掉。
  - 实现注意: `parseArgs` 先 `argv = [...argv]` 再展开, 不改调用方数组(单测钉住)。
- **doctor 预演清理**: `Archive.prune(keepDays, { dryRun: true })` 只报不删; doctor 据此打一行
  `[INFO] 归档保留期: N 天 —— 本次启动将删除 K 个旧日归档(文件名...)`。清理不可逆, 提前可见。
  实测(本机归档): `--archive-keep-days 1` → 会删 6 个旧日归档, 文件名逐条列出;
  未给该参数 → `[INFO] 归档保留期: 0(不清理; ...)`。
- **单测(+6)**: 三个等号形态解析、`--token=abc==` 原样、未知 `--foo=bar` 报错、调用方数组不被改、
  `dryRun` 只报不删。
- **自查踩坑 1**: 新加的 dryRun 用例会往同一临时目录写回一个 40 天前的文件, 导致后面
  `keepDays=0` 那条"没少文件"的断言拿旧快照比 → 误红; 改成取当前快照后绿。
- **自查踩坑 2(时序抖动)**: 本轮全量回归第一次跑时 `bridge-unit` 红了, 单独连跑 6 次却全绿 ——
  定位到 R15 加的 `net_list 3000 条 单次净耗时 < 1000ms` 断言: 全量回归里前序套件刚跑完,
  这台机器出现 1s+ 抖动就把它打红(该断言本意是拦"病态退化", 不是测绝对性能)。
  阈值放宽到 **3000ms** 且改名为"病态退化线"; 之后全量回归连跑 3 次全绿。
  教训: **性能类断言要么给足余量只拦数量级退化, 要么别放进门禁** —— 卡在机器噪声上就是假红。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接单测 | `node bridge/unit.mjs` | **62/62**(+6) |
| 桥接端到端 | `node bridge/smoke.mjs` | 49/49 |
| 自检 | `node bridge/src/doctor.js` | 18/18 + 保留期 INFO(0 与 N 两种形态) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **doctor**: 保留期 INFO 已可见; 可加"最早/最新归档日期"。
5. **等号写法延伸**: 布尔 flag 的 `--allow-control=false` 语义(当前不支持, 属可选增强)。

---

## R25 · v1.1.29 (2026-11-23)

### 归档保留期(`--archive-keep-days`, 默认不清理) + 顺手修掉负数参数的误导报错

- **动机**: 归档按天追加、默认永不清理 —— 本机实测已 **102.3 MB**(R20 doctor 读数)。长期跑会一直长,
  但"删数据"是不可逆动作, 所以默认 `0`(不清理), 要用户显式给天数。
- **实现**:
  - `config`: `--archive-keep-days <n>`, 范围 0..3650, 非法值启动前报错(码 2);
  - `Archive`: `new Archive(dir, { keepDays })` → `init()` 里 `prune()`; **只认
    `harvest-YYYY-MM-DD.jsonl`**, 同目录其它文件与非法命名一律不碰; 返回 `{removed, kept}`;
  - daemon 启动日志报删除数量; 代理模式拉起 daemon 时透传该参数。
- **单测(+5)**: 造今天/10 天前/40 天前/400 天前四个归档 + `notes.txt` + 非法名, `keepDays: 30` →
  删 40/400 天两条、保留期内不动、非归档文件不动、prune 报告 `{removed:2, kept:2}`;
  `keepDays: 0` → 一个都不删。
- **顺带修的 bug(参数守卫自身)**: `needValue` 把 `-1` 当成了"下一个 flag", 于是
  `--archive-keep-days -1` 报"缺少值"而不是"范围不对"; `--port -1` 同样。改为只把 `--xxx` 与
  `-字母` 当 flag, 负数交回范围校验。实测三条文案现在都准确:
  `--archive-keep-days -1` → 范围错误、`--port -1` → 范围错误、`--port --quiet` → 缺少值。
- 实测 daemon: 临时目录放一条 90 天前的归档, `--archive-keep-days 30` 启动后目录里 0 个文件。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接单测 | `node bridge/unit.mjs` | **56/56**(+5 保留期) |
| 桥接端到端 | `node bridge/smoke.mjs` | 49/49 |
| CLI 负路径 | 三个错参数 | 文案各自准确, exit 2 |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **doctor**: 显示 `--archive-keep-days` 生效值与"下次会删哪种日期"。
5. **参数守卫**: 已支持负数; 可再支持 `--flag=value` 形式(当前只支持空格分隔)。

---

## R24 · v1.1.28 (2026-11-23)

### 实跑"缺 python"降级分支(此前只写在代码里, 从未被执行)

- **动机**: 从 R1 起各测试都有 `TC.pythonBin()` 探测 + `SKIP(env)` 分支, 但本机装了 python,
  那些分支**一次都没跑过** —— 等于"降级路径未测", 到了真没解释器的机器上可能直接崩。
- **模拟尝试 1(失败)**: 从 PATH 剔除含 "python" 的段后跑, 探测却仍成功 —— 因为 Windows 的
  `C:\Windows\System32\py.exe` 还在 PATH 里, `py -3` 照样能拉起 python3。**结论: 光摘 PATH
  不能模拟缺解释器。**
- **模拟尝试 2(有效)**: 在 `test/lib/toolchain.js` 加显式测试钩子
  `WEBTOOLBOX_NO_PYTHON=1` → `pythonBin()` 返回 null。这是"环境模拟开关", 与真实探测解耦。
- **实测结果(全部退出码 0, 且摘要明示跳过项)**:
  - `test_regression`: `SKIP(env) pyscript py_compile` + `SKIP(env) pyscript Cookie glob 实跑`
    → `ALL REGRESSION TESTS PASSED (SKIP 2: ...)`;
  - `check_pychain`: `SKIP(env) 真实回放(mock server/驱动脚本)` + `SKIP(env) 生成脚本 py_compile`
    → `PY 链注入 PASS (SKIP 2: ...)`(静态断言照跑);
  - `check_toolchain`: `SKIP(env) python probe/pyRun` + 断言 `pythonBin 缺失时返回 null`、
    `python 缺失时 pyRun 抛错(显式失败而非假装成功)`。
- 恢复 `WEBTOOLBOX_NO_PYTHON` 后重跑 `check_pychain` → 无 SKIP, 正常全绿(钩子无副作用)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 降级分支 | `WEBTOOLBOX_NO_PYTHON=1 node test/regression|check_pychain|check_toolchain` | 三个文件全 exit 0 + 明示 SKIP |
| 正常路径 | `node test/run_all.js` | 56/56 PASS(钩子不影响) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **归档清理**: 按天保留 N 天(新功能, 需评估)。
5. **钩子统一**: `WEBTOOLBOX_NO_PYTHON` 之外, 可加 `WEBTOOLBOX_NO_BRIDGE_DEPS` 统一模拟
   桥接依赖缺失(现在靠改名 node_modules, 不适合 CI 并行)。

---

## R23 · v1.1.27 (2026-11-23)

### 闸门在"没装 bridge 依赖"的机器上不再逼人改文档

- **问题**: R7 起的文档闸门按"本机实际能跑的 suite 数"算期望值 —— `bridge/node_modules` 不在时
  期望变 53, 而文档写的是 56(描述仓库能力), 于是**没 npm install 的机器上文档闸门必红**,
  等于逼人把 56 改成 53 凑绿, 把"环境差异"写成"文档错误"。
- **改法**: 期望值恒按 3 个桥接 suite 计(文档描述的是仓库能力); 本机缺依赖时只打一行
  `SKIP(env) ... 本机实跑 53 个`, 不判红。同时把 `run_all` 的 SKIP 提示补全为三个 suite。
- **实测(临时把 bridge/node_modules 改名模拟)**:
  - `check_doc_counts` → `SKIP(env) ... 本机实跑 53 个` + `doc counts PASS (56 suites)`;
  - `run_all` → `SKIP(env) bridge-unit/bridge-exporters/bridge-smoke` + `全量回归 PASS: 53/53`;
  - 还原 `node_modules` 后回到 56/56。
- 这类"只有在别的机器上才暴露"的问题, 单靠本机全绿是发现不了的 —— 本轮主动构造了缺依赖环境。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归(有依赖) | `node test/run_all.js` | 56/56 PASS |
| 全量回归(模拟无依赖) | 同上 | **53/53 PASS + SKIP(env)** |
| 文档闸门(两种环境) | `node test/check_doc_counts.js` | 均 PASS(56 suites 语义不变) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **归档清理**: 按天保留 N 天(新功能, 需评估)。
5. **跨环境矩阵**: 再把"无 python"也模拟一遍(现有 SKIP(env) 分支同理未被实跑过)。

---

## R22 · v1.1.26 (2026-11-23)

### 控制开关"两个值"的可见性(本地 vs daemon)

- **真实故障面**: README 教用户先起 daemon 再让客户端接。`--allow-control` 是**两个独立开关**:
  MCP 进程自己的 `ctx.allowControl`, 与 daemon 侧的 `bridge.allowControl`。用户给客户端加了
  `--allow-control` 却忘了给 daemon 加(或反之), 控制类调用只会得到一句 `forbidden`, 完全看不出
  "该重启谁"。旧实现里 `bridge_status` 只报本地开关, 等于把矛盾藏起来。
- **改法**:
  - 代理 Hub 记录 READY 里的 `bridge.allowControl` → `hub.daemonAllowControl`(单进程模式为 `null`);
  - `bridge_status` 输出 `allowControl` / `daemonAllowControl` / `controlMismatch`, 不一致时附
    `hint` 明说"daemon 未启用控制类工具: 用 --allow-control 重启 daemon"或反向;
  - `controlGuard` 在"本地开了但 daemon 没开"时直接给专属文案(而不是让它走到 hub 再被拒)。
- **端到端验证(smoke 新块 [7])**: 起一个**没加** `--allow-control` 的 daemon(独立端口 9499) +
  一个**加了**的 MCP 进程, 挂假扩展后断言三条: `controlMismatch === true`、hint 指明重启谁、
  `page_click` 报 `错误[forbidden]` 且文案含 `daemon`。
  - **踩坑**: 第一版 [7] 忘了挂假扩展 → `bridge_status` 走"扩展未连接"早退分支, 三个字段都不在,
    断言误红; 给 `connect/connectRetry` 加 `base` 参数把假扩展连到 9499 后才真正覆盖到。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **49/49**(+6 开关一致性) |
| schema 闸门 | `node test/check_bridge_schema.js` | PASS |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **归档清理**: 按天保留 N 天(新功能, 需评估)。
5. **doctor**: 可把"控制类开关/扩展在线"两项也在非 daemon 模式下标注"未检测"。

---

## R21 · v1.1.25 (2026-11-23)

### 工具表加"结构化返回"列 + 闸门改为按列名定位

- **动机**: R18 之后有 5 个工具(`bridge_status`/`net_list`/`net_get`/`net_hosts`/`correlate`)
  会给 `structuredContent`, 但表里只在说明文字里提 —— 客户端作者扫一眼表看不出"哪个工具不用
  parse 文本"。
- **改法**: 表头加第 4 列"结构化返回", 5 个工具标 ✓, 其余留空。
- **顺手修掉闸门的一个隐患**: 原来判断"是否需要 --allow-control"用的是 **整行找 ✓**; 一旦表格
  出现第二列带 ✓(就是这轮的结构化列), 判断立刻失真(把只读工具当需要权限)。改为**按表头名定位
  列索引**(找含 `--allow-control` 与含 `结构化` 的表头), 并对两列分别断言"文档标记 === 实现":
  - 控制列 ↔ 工具块里有没有 `controlGuard(...)`;
  - 结构化列 ↔ 工具块里有没有 `return structured(` 或 `structuredContent:`。
  另加"表头必须有这两列"的断言, 防止有人删列后闸门静默退化。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 工具表闸门 | `node test/check_tool_table.js` | PASS(27 工具 / 23 行 / 两列 dual 断言) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **归档清理**: 按天保留 N 天(--archive-dir 的维护面, 属新功能需评估)。
5. **doctor**: 归档体积已可见; 可再输出"最早/最新归档日期", 便于判断是否还在写。

---

## R20 · v1.1.24 (2026-11-23)

### bridge 脚本聚合 + 脚本目标存在性闸门 + 归档体积

- **脚本聚合**: `bridge/package.json` 补 `smoke` 与 `test`(`unit → exporters → smoke` 串行,
  任一层红即非零)。实测 `npm test`: unit 51 / exporters 29 / smoke 43 全通过 —— 桥接层从此有
  一条命令的入口, 不必记三个文件名。
- **闸门**: `check_doc_counts` 新增"package.json 里 `node ./x.js` 的脚本目标必须存在"
  —— R1 那个 `doctor` 指向不存在文件、直到有人手动跑才发现的问题, 以后第一次跑全量就会红。
- **归档体积**: doctor 增加 `[INFO] 归档体积: 102.3 MB`(递归累加, 超 1GB 附清理建议);
  与 R16 的磁盘余量一起, 让"归档是不是在偷偷长胖"变成看得见的事。仍是 INFO, 不改退出码。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接聚合 | `cd bridge && npm test` | unit 51 / exporters 29 / smoke 43 全 PASS |
| 自检 | `node bridge/src/doctor.js` | 18/18 + 归档体积/余量两行 INFO |
| 文档闸门 | `node test/check_doc_counts.js` | PASS(脚本目标存在断言) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
4. **工具一览表**: 增加"结构化返回"列。
5. **归档维护**: `--archive-dir` 支持按天清理(保留 N 天)属于新功能, 需评估是否该做。

---

## R19 · v1.1.23 (2026-11-23)

### 覆盖清单补 9 个走查 + 清单完整性闸门

- **实测缺口**: `test/README` 自称"覆盖清单", 但 49 个走查文件里 **9 个没有行**:
  `check_ai_hygiene` / `check_auto_chain` / `check_console` / `check_jmx_auto_assert` /
  `check_jmx_setup_login` / `check_mcp_regression` / `check_page_tab` / `check_ui_fixes` /
  `check_unmatched_hint` —— 全是"曾经修过的真实缺陷"的看门测试, 却在清单里查不到,
  等于维护者不知道这些行为被钉住过。
- **改法**: 逐个读文件头与断言, 按现有风格补 9 行(主题 + 来源版本); 并在
  `check_doc_counts` 加闸门: **每个 `check_*/`e2e_*` 文件都必须在清单里有一行**, 缺一个就红。
- 这轮没有改产品代码, 但补的是"可维护性资产": 新人/代理靠这张表判断"哪些行为动过就有人管"。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 文档闸门 | `node test/check_doc_counts.js` | PASS(新增清单完整性断言, 49/49 文件有行) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **doctor**: 归档目录体积提示。
4. **样本库边界**: "无 body 的 POST"/"超长 query"样本。
5. **工具一览表**: 增加"结构化返回"列(现在只在说明文字里写)。

---

## R18 · v1.1.22 (2026-11-23)

### net_get: 截断从"文本尾巴"变成"机读字段"

- **原状**: 正文超限时只在字符串尾部拼一句 `…(已截断, 原文 N 字符…)` —— 客户端要判断"我拿到的是不是
  全文", 只能对文本做正则; 而 `net_get` 又是最容易在长响应上踩坑的工具。
- **改法**: `net_get` 加 `outputSchema` + `structuredContent`:
  `{ id, method, url, path, query, status, mime, headers, body, response, truncated, originalChars, maxBody }`。
  - `truncated` 布尔、`originalChars` 原始字符数、`maxBody` 实际生效上限;
  - `content` 文本仍保留完整条目(含未声明字段), **信息不因结构化而丢**;
  - `response` 内容与之前一致(截断时仍带那句说明, 人读也清楚)。
- **断言(smoke +2)**: 未截断时 `truncated=false / originalChars=5`;5000 字符 + `maxBody=100` 时
  `truncated=true / originalChars=5000 / maxBody=100` —— 旧实现没有这些字段, 断言不可满足。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **43/43**(+2 机读截断) |
| schema 闸门 | `node test/check_bridge_schema.js` | PASS(5 个结构化工具, 成对) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **doctor**: 归档目录体积提示(现在只有余量)。
4. **样本库边界**: "无 body 的 POST"/"超长 query"样本覆盖导出器分支。
5. **工具表**: 可在"工具一览"里补一列"结构化返回"标记(现在只在说明文字里写)。

---

## R17 · v1.1.21 (2026-11-23)

### 消掉样本库的两处 skip(结构样本改"合成保留域"真跑)

- **原状**: `samples/opensource/apache-jmeter`(3 条) 与 `taurus/jmx-structure`(23 条) 是从
  `.jmx` 解析出的**相对路径**, 没有域名 —— 测试里直接 `continue` 跳过, 于是
  **buildJmx 对"无域名/相对路径"输入的兜底行为零覆盖**, 而样本库清单看起来"全部样本都被消化"。
- **改法**: 合成 RFC 6761 保留域 `sample.invalid` 补全 URL 后照常跑导出器, 并加一条硬断言:
  **采样器数必须等于条目数**(不许因为"没域名"静默丢条目)。实测两样本均通过, `skip buildJmx`
  输出消失。
- 这条改变的是"覆盖", 不是"降级": 合成域只在无绝对 URL 时使用, 真实样本原样。

### schema 形态再收紧

- `check_bridge_schema` 的禁列从 `z.any()/z.record()` 扩到 `z.unknown()/z.lazy()`:
  参数 schema 一旦松成"随便什么", 客户端就没法给模型正确的填参提示。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 样本库 | `node samples/test_regression_samples.js` | PASS(15 样本/96 条, 无 skip) |
| schema 闸门 | `node test/check_bridge_schema.js` | PASS(27 工具) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **`net_get` 机读截断标记**: 需要给 net_get 定 outputSchema(字段面宽, 需评估)。
4. **doctor**: 归档目录体积提示(现在只有余量)。
5. **样本库**: 可再补"无 body 的 POST"/"超长 query"边界样本, 覆盖导出器分支。

---

## R16 · v1.1.20 (2026-11-23)

### net_get 正文截断行为(协议层断言) + 归档磁盘余量 INFO

- **`net_get` 截断**: 5000 字符正文 + `maxBody: 100` → 返回第 101 个字符起被截断(前 100 原样),
  且响应里明示"原文 5000 字符"; `maxBody: 1` 会被夹到下限 100(否则 JSON 结构会被切坏)。
  这两条此前只有描述没有断言 —— 一旦有人把截断改回"静默丢后段", 客户端会以为拿到了全文。
  - **断言写法纠正**: 一开始想在原始 text 上用正则剥掉截断尾巴再 `JSON.parse`, 结果 JSON 尾部
    还有 `\n}`, 正则匹配不上 → 误报; 改成**直接解析 JSON** 后断 `response[100] !== "y"`
    (前缀 100 个 y 之后立刻是说明文本)。
- **归档磁盘余量**: doctor 用 `fs.statfsSync` 打一行 INFO(实测 99.2 GB), 低于 1 GB 时附带清理建议;
  拿不到就静默跳过, 不参与退出码。归档是按天追加的明文流量, 长跑前先看余量。
- **doctor 检查项数不变(18)**: 余量是 INFO 不是断言 —— 磁盘紧张不该让"桥接自检"失败。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **41/41**(+3 截断) |
| 自检 | `node bridge/src/doctor.js` | 18/18 + `[INFO] 归档磁盘余量: 99.2 GB` |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **错误码覆盖**: `net_get` 截断目前只在文本里说, 可考虑附带 `truncated/originalChars` 机读字段
   (需要给 net_get 定 outputSchema, 字段面较宽, 需评估)。
4. **schema 形态**: 已禁 `z.any/z.record`; 可再禁 `z.unknown`/`z.lazy`。
5. **doctor**: 可加"归档目录体积"提示(现在只有余量)。

---

## R15 · v1.1.19 (2026-11-23)

### net_list 在 3000 条规模下的行为基线(unit +7)

- **动机**: 扩展单会话上限是 3000 条, 而 `net_list` 每次要把全部条目过滤一遍再切片。此前只有
  单条/几条的断言 —— "规模一变就退化"(比如有人把摘要改回带 response)没有任何防线。
- **断言(不测绝对性能, 测三件会退化的事)**:
  - `limit: 50` 在 3000 条里返回 50 条、`total` 仍报 3000;
  - 摘要**不含** `response` 字段, 且序列化体积 < 60KB(带正文会瞬间到 MB 级);
  - 净耗时 < 1000ms(宽松上限, 只拦病态退化不拦机器慢);
  - `status: 500` 过滤**扫全量**(300 条命中, 返回首 50);
  - `offset: 2990` 末页按实际返回 10 条(不补齐、不越界)。
- 实现走 `registerTools(fakeServer, hubStub)` 真注册 + 真 handler 调用(不是复制一份逻辑)。

### 归档目录 0700(unit +1)

- 归档目录里是明文流量 JSONL; `archive.init` 用 `mode: 0o700`, 现在 POSIX 下按 `mode & 0o077 === 0`
  实测(Windows 标不适用)。配合 R14 的文件 0600, 目录/文件两层都钉住。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接单测 | `node bridge/unit.mjs` | **51/51**(+8) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **doctor**: 归档目录磁盘余量只读提示。
4. **错误码覆盖**: `net_get` 大正文截断时是否该给"有更多"的可机读标记(现在只在文本里说)。
5. **schema 形态**: 已禁 `z.any/z.record`; 可再禁 `z.unknown`/`z.lazy`。

---

## R14 · v1.1.18 (2026-11-23)

### 分页/夹取边界 + 归档权限 + 单位口径澄清 + schema 形态约束

- **`net_list` 边界(smoke +3 项)**: `limit: 5000` 夹到 500 且仍按实际条数返回;
  `offset: 999` 越界 → `returned: 0` 但 `total` 仍报原始条数(分页不能把"没有更多"伪装成"没抓到");
  过滤无命中 → 不报错, 用 `filtered/returned = 0` 表达(与导出类工具的 `no_entries` 错误区分开)。
  - 自查: 首版断言写成 `clamped.filters === undefined`(查一个不存在的属性 = 恒真), 已收紧为
    `limit===500 && returned===1 && total===1`。
- **归档文件权限(unit +1 项)**: 归档是明文流量, POSIX 下 `mode & 0o077 === 0`(0600);
  Windows 标"不适用(ACL 继承)"。
- **单位口径澄清**: `net_get` 的 `maxBody` 是**字符**截断, 而 `net_list` 的 `reqBytes/respBytes`
  是 **UTF-8 字节数**(中文 1 字符=3 字节) —— 两个数不能直接比大小, 已写进工具描述(模型看得到),
  否则会得出"我明明要了 20000 字怎么才这么点"的错误结论。
- **schema 形态约束**: `check_bridge_schema` 新增"inputSchema 不得用 `z.any()`/`z.record()`"
  (借参考仓库 `@local/enforce-zod-schema` 的思路: 参数必须是短、可填、有约束的;
  当前 27 个工具一个都没有, 用断言保持住)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 56/56 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **38/38**(+3 分页边界) |
| 桥接单测 | `node bridge/unit.mjs` | **43/43**(+1 归档权限) |
| schema 闸门 | `node test/check_bridge_schema.js` | PASS(+形态约束) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **performance 基线**: 3000 条抓包下 `net_list` 瘦身/过滤耗时上限断言(防退化)。
4. **doctor**: 已 18 项; 可再加"归档目录磁盘余量"只读提示。
5. **SECURITY 覆盖面**: 令牌权限在 POSIX 已验; 可加"归档目录 0700"断言。

---

## R13 · v1.1.17 (2026-11-23)

### 安全文档 ↔ 实现事实闸门(新 `check_security_claims`)

- **动机**: 安全文档错比功能文档错更贵 —— 写"权限只有这 8 个"而 manifest 多一个, 或写"令牌 0600"
  而代码没带 `mode`, 用户会基于错的保证做决定。R12 写完 SECURITY.md 后, 当即把可静态核对的事实
  全部钉住:
  - 权限清单: SECURITY 列的 8 个 ↔ manifest `permissions` 集合完全相等; 无 `host_permissions`;
    `optional_host_permissions` 只含 http/https 两类; `debugger`/`sidePanel` 在位;
  - 网络面: `config` 默认 `127.0.0.1` + 端口 `9280`, SECURITY 写明回环;
  - 令牌: 文件 `0o600`、目录 `0o700`、比较用 `timingSafeEqual`、hub 走 `safeEqual(frame.token)`;
  - 控制面: `allowControl` 默认 false + hub 对控制方法二次拦截 + `page_eval` 注解 `destructiveHint`;
  - 零依赖: 仓库根没有 `package.json`, `bridge/package.json` 存在;
  - "不做"清单与非承诺(debugger 黄条)必须在文档里。
- 首次运行即全绿(说明 R12 文档没有吹牛), 且此后任一方向漂移都会红。

### doctor: daemon 版本 = 包版本

- `index.js`/`hub.js` 的 `VERSION` 是手写常量, 与 `bridge/package.json` 脱钩后客户端看到的
  "报的版本"与"装的版本"就不是一回事。doctor 用 READY 里的 `bridge.version` 与 package.json 对拍:
  实测 `daemon 0.1.0 / package 0.1.0` PASS, doctor **18/18**。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **56/56 PASS** |
| 安全闸门 | `node test/check_security_claims.js` | PASS(首次即全绿) |
| 自检 | `node bridge/src/doctor.js` | 有 daemon **18/18** |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **schema 形态规则**: 评估禁 `z.any()`/`z.record` 出现在 inputSchema(当前无, 属预防)。
4. **SECURITY 覆盖面**: 可加"归档目录明文流量"文件权限断言(现有 0600 由 archive.js 保证, 未验)。
5. **performance**: 大抓包(3000 条)下 `net_list` 瘦身/分页的实际耗时, 可做基线断言防退化。

---

## R12 · v1.1.16 (2026-11-23)

### 新增 SECURITY.md(对标参考仓库的安全策略文档)

- **动机**: 参考仓库有 `SECURITY.md`(Security policy / Scope / Trusted host environment /
  Network guardrails / JavaScript evaluation)。本仓库能力面更大(能点按钮、能执行任意 JS、
  有本地监听端口), 却没有一份"谁能触达什么"的文档 —— 用户只能从散落的 README 段落里拼。
- **内容**: 三道闸门逐条写清(域名授权 `optional_host_permissions` / 桥接令牌 0600 + 定长比较 /
  `--allow-control` 控制开关与工具注解), 外加:
  - 监听地址暴露面(默认回环; 非回环时令牌是唯一防线, doctor 会 FAIL);
  - 数据落点与卫生(`chrome.storage.local` / `~/.web-toolbox/archive` 明文 JSONL / Cookie 桥
    导出的 `cookies_*.state.json` 属会话凭据);
  - `page_eval` 的 JS 执行面(等价 DevTools 手打, 标注 destructive);
  - **"不做"清单**(不做进程隔离/不做加密存储/不隐藏 debugger 黄条), 避免读者高估边界;
  - 报告口径(附 doctor 输出、敏感值先打码)。
- **不写空话**: 每条都对着实现里的具体开关与文件路径; 与 README/AGENTS 互相链接, 由闸门保证链接不断。

### 闸门扩展(check_doc_counts)

- 新增"README 写的『共 N 个工具』必须等于 `register()` 实际数量"(现存 27) —— 工具增删后忘改
  概览数字会直接红;
- 新增"文档间相对 `.md` 链接必须存在"(README/AGENTS/CLAUDE/bridge README/test README/REVIEW
  六份互链, 断链即红);
- 新增"SECURITY.md 存在且覆盖三道闸门关键词"。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 55/55 PASS |
| 文档闸门 | `node test/check_doc_counts.js` | PASS(含工具数/断链/SECURITY 三项新断言) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **SECURITY 与实现联动**: 把 SECURITY 里写的令牌/权限事实做成断言(权限清单、0600、回环默认)。
4. **doctor 覆盖面**: daemon 版本 vs 包版本一致性。
5. **schema 形态规则**: 评估禁 `z.any()`/`z.record` 出现在 inputSchema(当前无, 属预防)。

---

## R11 · v1.1.15 (2026-11-23)

### structuredContent 自校验(字段漂移翻成可读错误)

- **问题**: `outputSchema` 的校验由 SDK 做, 失败时客户端收到的是一句协议层 message ——
  既没说是哪个工具, 也不告诉用户"这是 bridge 自身的问题"。而且 schema 与返回值漂移只有在真调
  那个工具时才暴露。
- **改法**: `makeRegister` 包装 handler: 带 `outputSchema` 且返回 `structuredContent` 时, 先用
  `z.object(def.outputSchema).safeParse` 自验; 不符则返回
  `错误[bad_payload]: 工具 <name> 的 structuredContent 与 outputSchema 不符: <字段>: <原因>`
  + 下一步"这是 bridge 自身字段漂移"。`isError` 结果跳过校验(错误里没有 structuredContent)。
- **可测性**: `makeRegister` 导出给单测用(伪造 `server.registerTool` 捕获 handler);
  `bridge/unit.mjs` 新增 `[register]` 7 项: 缺注解即抛 / 类型不符 → bad_payload 且指名工具 /
  指出具体字段 / 多声明外字段(按 schema 为准) / 合法原样透传 / isError 跳过校验 / 缺注解报错文案。
  26 → 35 → **42 项**。

### doctor: 归档目录可写 + 令牌文件权限

- 「归档目录可写」: 真 `mkdir + 写探针 + 删`(`--archive-dir`), 不可写直接给"换个可写目录"的指引;
  实测 PASS(D:\Users\...\.web-toolbox\archive)。
- 「令牌文件权限」(POSIX): `mode & 0o077` 必须为 0; Windows 上标"不适用(ACL 由用户目录继承)"
  仍 PASS, 保证不同平台检查项数一致。有 daemon 时 doctor **17/17**。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 55/55 PASS |
| 桥接单测 | `node bridge/unit.mjs` | **42/42**(+7 register) |
| 桥接端到端 | `node bridge/smoke.mjs` | 35/35 |
| 自检 | `node bridge/src/doctor.js` | 有 daemon **17/17** |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **自校验覆盖面**: 现在只有 4 个结构化工具走自验; 若未来加 `outputSchema`, gate 已有
   `check_bridge_schema` 管"是否成对", 自验自动生效。
4. **doctor 覆盖面**: 可加"daemon 版本 vs 包版本"与"--allow-control 与 README 表一致"的交叉检查。
5. **schema 形态规则**: 评估禁 `z.any()`/`z.record` 出现在 inputSchema(当前无, 属预防)。

---

## R10 · v1.1.14 (2026-11-23)

### CLI 参数守卫: 错参数不再静默 / 不再 NaN 崩

- **实测缺陷**:
  - `--port http` → `Number("http")` = NaN → 到 `new WebSocketServer({port:NaN})` 才抛晦涩错误;
  - `--port`(漏值)→ 端口变成 `Number(undefined)` = NaN, 同上;
  - **未知参数被静默忽略** —— 把 `--allow-control` 拼成 `--alow-control`, 进程照常启动, 控制类工具
    却全被 `forbidden` 打回, 用户只会看到"未启用", 不知道是自己拼错了。
- **修**: `config.parseArgs` 加三层守卫 —— 值缺失(含"下一个 token 又是 flag")、`--port` 必须
  1..65535 整数、未知 `-` 开头的参数直接报错并列出可用参数; `index.js`/`doctor.js` 捕获后
  **一行提示 + 退出码 2**(不甩栈)。实测:
  - `node src/index.js --alow-control` → `参数错误: 未知参数: --alow-control(可用: ...)`, exit 2;
  - `node src/index.js --port http` → `--port 必须是 1..65535 的整数, 收到: http`, exit 2;
  - `node src/doctor.js --port 0` → `[FAIL] 参数解析 — --port 必须是 ...`, exit 2。
- **单测**: `bridge/unit.mjs` 新增 `[config]` 9 项(默认值/正常解析/非数字/越界/漏值/吞 flag/
  未知参数/空 host/`--help`), 26 → **35 项**。

### doctor: 监听地址暴露面检查

- 新增首项检查「监听地址是本机回环」: 绑到 `0.0.0.0`/局域网 IP 时令牌是唯一防线(本地文件里的
  一串 hex), 属于用户该明确知道的暴露面。默认 `127.0.0.1` 直接 PASS;用其他地址则 FAIL 并给出
  回退建议。有 daemon 时 doctor **15/15**。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 55/55 PASS |
| 桥接单测 | `node bridge/unit.mjs` | **35/35**(+9 config) |
| 桥接端到端 | `node bridge/smoke.mjs` | 35/35 |
| 自检 | `node bridge/src/doctor.js` | 有 daemon **15/15** |
| CLI 负路径 | 三条错参数 | 全部 exit 2 + 一行明确提示 |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **errors 码表**: 补 `structuredContent` 校验失败(SDK 侧)的码。
4. **doctor 覆盖面**: 可加"归档目录可写"与"令牌文件权限(非 0600 提示)"。
5. **schema 形态规则**: 评估禁 `z.any()`/`z.record` 出现在 inputSchema(当前无, 属预防)。

---

## R9 · v1.1.13 (2026-11-23)

### 工具表 ↔ 实现一致性闸门(发现文档漏了 3 个能力)

- **实测漂移**: `bridge/README` 的「工具一览」表停在 v1.1.0, **v1.1.1 加的 `chain_replay` /
  `console_read` / `console_clear` 从未进表** —— 用户读文档会以为 MCP 只能抓包, 不知道能跑回归、
  能读控制台。这正是"能力存在但没人知道"的隐性损失。
- **修**: 补三行(带正确的 `--allow-control` 标记: chain_replay ✓ / console_read 空 / console_clear ✓);
  新增 `test/check_tool_table.js` 三条断言:
  1. 27 个 `register(...)` 工具**必须**都出现在表里(漏一个红, 首次跑就抓到那 3 个);
  2. 表里点名但代码没有的工具名 → 红(白名单只有非工具术语 `annotations`);
  3. 表里"需要 --allow-control"列(✓)必须与 `controlGuard` 是否存在于该工具块**严格一致** ——
     标错会让模型以为免权限, 真调时被 `forbidden` 打回。
- **踩坑**: 断言对象字面量里用了带 `✓` 的键名(`文档标✓`), JS 标识符不允许 → SyntaxError;
  改成 ASCII 键名。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **55/55 PASS** |
| 工具表闸门 | `node test/check_tool_table.js` | 补表前 1 红(3 个工具缺失) → 补后 PASS(27 工具/23 行) |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **根 README 工具覆盖**: 目前只提 10 个工具(合理, 面向快速上手), 可加一句"完整 27 个见 bridge/README"。
4. **errors 码表**: 补 `structuredContent` 校验失败(SDK 侧)的码。
5. **schema 形态规则**: 评估禁 `z.any()` / `z.record` 出现在 inputSchema(当前无, 属预防)。

---

## R8 · v1.1.12 (2026-11-23)

### schema 可读性闸门(27 工具 × 全部输入参数描述)

- **对标**: 参考仓库每个 schema 字段都写 `.describe()`, 且有专门的 eslint 规则管 schema 形态
  (`@local/enforce-zod-schema`: 禁 `.nullable()` / 禁 schema 里 `zod.object()`, 复杂对象要求
  压成短字符串)。本仓库 27 个工具里有 **16 个输入字段没描述**(`tabId` ×13、`page_type.ref/text`、
  `correlate.pathIncludes`、`page_scroll.deltaX`)—— 客户端把描述喂给模型, 没描述等于让模型猜。
- **改法**: 16 处全部补描述(口径统一: `tabId` = "目标标签页 id, 省略用活动标签页");
  新增 `test/check_bridge_schema.js` 作为闸门:
  - inputSchema 顶层字段必须 `.describe(`(含 spread 源 filterShape 自身字段);
  - 顶层 spread 只允许已描述的共享 shape(白名单 `filterShape`);
  - 每个工具必须有 title 与 description;
  - `structured()` 调用与 `outputSchema` 成对(避免 SDK 丢弃/校验失败);
  - **解析坑**: CRLF 文件里 `split("\n")` 会留下 `\r`, JS 正则的 `.` 不匹配 `\r` → 一律
    `split(/\r?\n/)`(否则扫描器"全绿"但一个字段都没检查, 比没有闸门更危险)。
- **顺带的自我证明**: 首次跑闸门就抓到全部 16 处, 补完才绿。

### doctor: READY 协议版本一致性 + 控制类开关读数

- 活体握手现在把 READY 里的 `protocol` 与本地 `PROTOCOL_VERSION` 对拍 —— 版本不一致会在 Hub 那
  一步变成 `protocol_mismatch`, 提前查出来更好定位。
- 新增 INFO 行: 控制类工具是否启用(从 READY 的 `bridge.allowControl` 读)。
- 实测(有 daemon): **14/14 PASS**, 两行 INFO(控制类未启用 / 扩展离线)。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **54/54 PASS** |
| schema 闸门 | `node test/check_bridge_schema.js` | 补前 16 处红 → 补后 PASS(27 工具) |
| 桥接端到端 | `node bridge/smoke.mjs` | 35/35 |
| 自检 | `node bridge/src/doctor.js` | 有 daemon **14/14** + 2 行 INFO |

### 下一轮候选(更新)

1. **等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **outputSchema 描述**: 现在只要求 input 字段带描述; output 字段(机读, 不喂模型)可按需补。
4. **errors 码表**: 补 `structuredContent` 校验失败(SDK 侧)的码。
5. **schema 形态规则**: 借鉴参考仓库 `@local/enforce-zod-schema` 的 `.nullable()`/`object` 禁令,
   评估本仓库 inputSchema 是否要禁 `z.any()`(现在没有, 但未来可能被引入)。

---

## R7 · v1.1.11 (2026-11-23)

### 文档计数/版本漂移闸门(把"我会记得同步"变成机器保证)

- **动机**: R1 发现 AGENTS 写"34 项/1.0.82"而实际是 46 项/1.1.4。这类漂移每轮都要手工追,
  而且它骗的是**读者**(代理照文档判断"门禁全绿")。与其靠纪律, 不如让测试红。
- **新增** `test/check_doc_counts.js`:
  - 按 `run_all.js` 同口径**现算** suite 数(根 2 + samples 1 + `test/check_*/e2e_*` 发现数 +
    `scan_conflicts` 1 + `bridge/node_modules` 存在时的 3 个桥接 suite), 不写死;
  - 与 AGENTS("N 项"/"N/N"/结束卫生)、CLAUDE、test README、README 目录树、REVIEW 门禁逐一对拍;
  - 版本号与 `manifest.json` 对拍(AGENTS/CLAUDE 的"当前 x.y.z");
  - 反向扫描三份文档里残留的其它 "N 项" 计数(>10), 防"改了一处漏三处"。
  - **自证**: 加上本文件后 suite 数 52→53, 闸门立刻红(9 项失败并打印"应该写什么"), 补完文档才绿。
- 副产品: 这条闸门也约束了未来所有轮次 —— 新增走查文件不更新文档 = 门禁红。

### net_hosts 结构化

- `net_hosts` 返回值是数组, 而 MCP 的 `outputSchema` 根必须是对象 —— 所以 `content` 保持原数组
  (兼容既有调用方), `structuredContent` 用 `{total, hosts:[{host,count}]}` 包裹。
- smoke 断言 `total === 3`(两条记录 2+1)/ hosts 长度 / 首项 host, 并核对了"四个机读工具都带
  outputSchema"(bridge_status/net_list/correlate/net_hosts)。

### 发现但**未改**(AGENTS §5 ask-first: 录制引擎配额裁剪)

- `background.js:358` 与 `common.js:544` 用 **字符数** `200000` 作为响应体上限, 而注释/README
  口径是 "200KB"。中文/emoji 每字符 3-4 字节 → 实际落 `chrome.storage.local`(10MB 字节配额)的
  体积可达标称的 3 倍, 长会话更容易顶到配额。
- 修法建议(待批): 抽 `truncateByBytes(s, 200000)`(TextEncoder 逐段/二分切, 不切坏代理对),
  `background.js` 落库与 `common.js` 读入两处同改; 配套走查断言"ASCII 不变、中文按字节、
  代理对不被切成半个字符"。
- 属于"录制引擎核心/配额裁剪"改动, 按 AGENTS.md §5 先问再做 —— 本轮只记录, 不动代码。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | **53/53 PASS**(含新闸门) |
| 文档闸门 | `node test/check_doc_counts.js` | 补文档前 9 红 → 补后 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **35/35**(新增 net_hosts structuredContent) |

### 下一轮候选(更新)

1. **等批**: 上述 200KB→200KB(字节) 体积口径修正(录制引擎配额裁剪, ask-first)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
3. **doctor 覆盖面**: 扩展在线读数已加, 可再验"READY 能力开关/协议版本"三项一致。
4. **errors 码表**: 补 `structuredContent` 校验失败的码(SDK 侧失败目前走 `error` 兜底)。
5. **net_get 大文本策略**: 描述里明说"不做结构化、正文按 maxBody 截断", 并在 errors 里给调参指引。

---

## R6 · v1.1.10 (2026-11-23)

### 字节口径修正(真缺陷) + correlate 结构化 + doctor 扩展在线读数

- **`reqBytes`/`respBytes` 语义错**: 原实现 `String(e.body).length` 数的是 JS 字符串长度
  (UTF-16 码元), 字段名却承诺字节数。中文/emoji 每字符 3-4 字节 → 对中文接口低报 2-3 倍,
  客户端按它算上下文预算或判断"响应多大"会漏。改为 `TextEncoder().encode(s).length`
  (Node 与浏览器两界通用, `Buffer.byteLength` 仅作兜底)。
  - 区分度: smoke 用 `body: "你好"` / `response: "世界"` —— 旧实现给 2, 新实现给 6;
    断言 `=== 6` 只能被新实现满足。
- **`correlate` 结构化**: 返回值本来就是 `{groups, summary}`, 补 `outputSchema`
  (groups[]: method/path/count/dynamics[]: path/values/var/replace/classify) + `structuredContent`。
- **doctor 扩展在线读数**: 活体握手复用 READY 帧里的 `bridge.extensionOnline`, 单列一行 INFO
  (不影响退出码):
  - 在线 → `[INFO] 扩展在线: 是(工具可直接用)`
  - 离线 → `[INFO] 扩展在线: 否 —— 在 Chrome 打开扩展配置页「AI 桥接」点「立即连接」`
  - 实测(无 Chrome): INFO 显示离线, doctor 仍 13/13 PASS —— 扩展没连不是 bridge 的病,
    但决定用户下一步做什么。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 52/52 PASS |
| 桥接端到端 | `node bridge/smoke.mjs` | **34/34** |
| 自检 | `node bridge/src/doctor.js` | 有 daemon 13/13 + INFO 扩展在线行; 无 daemon 12 项 |

### 下一轮候选(更新)

1. **扩展侧字节口径对齐**: 侧栏/详情页若也显示"大小", 检查是否同样用 `.length`(bridge 修了但呈现层可能分叉)。
2. **其余工具结构化**: `net_hosts`(`[{host,count}]` 已知形态)可接; `net_get`/`export_*` 属大文本, 保持纯文本并在描述里说明。
3. **只读注解收益验证**: 找 Claude Code 侧配置样例验证 `readOnlyHint` 放行。
4. **doctor 覆盖面**: 把 `extensionOnline` 也纳入 `bridge_status` 的 structuredContent 字段说明(已存在 recording/extension, 核对命名一致)。
5. **errors 码表**: 补 `structuredContent` 校验失败的码(SDK 侧失败目前走 `error` 兜底)。

---

## R5 · v1.1.9 (2026-11-23)

### 结构化返回 + doctor 活体校验 + 清洗降级分支

- **结构化返回(对标参考仓库的 machine-readable 输出)**: SDK 1.32.1 支持 `outputSchema` +
  `structuredContent`(注册时带 schema, 返回时 SDK 会校验)。先给两个"AI 必调"的工具接上:
  - `bridge_status`: `{connected, extension?, allowControl?, recording?, hint?}`;
  - `net_list`: `{total, filtered, offset, limit, returned, entries[]}`, 条目字段逐个声明
    (id/ts/method/url/path/status/durationMs/mime/reqBytes/respBytes)。
  - 新增 `structured(obj)` helper: `content` 仍给人类可读 JSON, `structuredContent` 给机读字段。
    schema 与返回值同源, 多一个少一个字段 SDK 都会拒 —— 这条正是 smoke 在验的。
- **doctor 令牌活体校验**: 以前只验"令牌文件存在 + 端口在听", 放过最常见故障(令牌轮换过/填错)。
  现在真拨一次 WebSocket, HELLO 带令牌, 让 daemon 用**它自己的令牌**判定:
  - 有 daemon + 正确令牌 → `13/13 PASS`, 该行显示 `READY(角色 proxy)`;
  - 有 daemon + 错误令牌 → 恰好该项 FAIL(`daemon 拒绝: unauthorized bad token`);
  - 无 daemon → 该项不执行(端口项已经报了, 不重复红), 仍是 12 项。
- **清洗降级分支**: `exporters.clean()` 有"扩展侧没有 `filterSkippable` 就原样返回"的降级路径,
  此前零断言。用猴补摘掉该函数: 断言不炸、HAR/JMX/PY 全量导出(6 个采样器)、还原后回到 3 个。

### 证据

| 层 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `node test/run_all.js` | 52/52 PASS(内含桥接三层) |
| 桥接端到端 | `node bridge/smoke.mjs` | **32/32**(新增 structuredContent 与 outputSchema 断言) |
| 导出口径 | `node bridge/test-exporters.mjs` | **29/29**(新增降级分支 3 项) |
| 自检 | `node bridge/src/doctor.js` | 有 daemon **13/13**;错误令牌精确红 1 项;无 daemon 12 项 |

### 下一轮候选(更新)

1. **其余工具的结构化**: `net_get`/`export_*`/`correlate` 仍是纯文本, 可评估 outputSchema(大文本不适合结构化, 需按工具判断)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例, 验证客户端确实按 `readOnlyHint` 放行。
3. **录制字段口径**: `durationMs`/`reqBytes`/`respBytes` 与参考仓库 `network.ts` 字节口径对拍。
4. **doctor 覆盖面**: 增加"扩展是否在线"的读数(READY 里 extensionOnline)并给出对应建议。
5. **errors 码表**: 补 `structuredContent` 相关失败路径的码(当前 SDK 校验失败会以 `error` 兜底)。

---

## R4 · v1.1.8 (2026-11-23)

### 导出口径单测 + 单源证明

- **为什么**: `bridge/src/exporters.js` 是"加载扩展同一份源码"的薄封装, 此前只被 smoke 间接覆盖 ——
  "HAR 保真 vs JMX/PY 压测剔除"这条口径差异、`pick` 的圈定语义、`opts.threads` 覆盖点都没有断言。
- **新增** `bridge/test-exporters.mjs`(26 项, 不连浏览器):
  - `pick`: 不给 ids / 空数组 → 全量; 按 id 过滤且未知 id 忽略; 不改原数组;
  - HAR 保真口径: 1.2 骨架、条数与输入一致(**不剔除静态资源**)、`time` 用 `durationMs`、
    缺 `durationMs` → `-1`、`status=0` 原样保留(错误态不失真);
  - JMX/PY 压测口径: 剔除静态资源/OPTIONS 预检/SSE 后只剩 3 个采样器、不含噪音路径、
    全噪音时明确报 `过滤后没有条目`(不产出空脚本)、`opts.threads` 写死线程组数值、
    默认 `__P(threads,1)` 可被 `-J` 覆盖;
  - correlate: `{groups, summary}` 形态;
  - **单源证明**: 猴补扩展侧 `jmx.buildJmx` / `pyscript.buildPyScript` / `common.buildHar`,
    bridge 输出必须**立刻**变成 sentinel —— 复制品改不动, 这条断言能区分"真加载"与"抄一份"。
- **口径记录(与参考仓库对照)**: 参考仓库 `NetworkFormatter` 的 status 是**字符串**
  (`"200"` / `failure.errorText` / `"pending"`); 本仓库录制条目 `status` 是数字且 **0 = 失败态**,
  HAR 里原样落 0(不伪装成 200/-1)。差异属实现口径不同, 已在测试里钉住, 避免未来"顺手统一"把
  错误态抹平。

### 下一轮候选(更新)

1. **结果结构化**: 评估 `structuredContent` 给 `net_list`/`bridge_status` 机读字段(需核 SDK 支持面)。
2. **只读注解收益验证**: 找 Claude Code 侧配置样例, 验证客户端确实按 `readOnlyHint` 放行。
3. **doctor 活体校验**: 临时连接 daemon 验令牌可被接受(现在只验文件存在与端口在听)。
4. **exporters 边界**: `common.filterSkippable` 缺函数时的降级分支(`typeof !== "function"`)没有断言。
5. **录制字段口径**: `durationMs`/`reqBytes`/`respBytes` 与参考仓库 `network.ts` 的字节口径对拍。

---

## R3 · v1.1.7 (2026-11-23)

### 错误语义: 从"一句话"到"码 + 下一步", 并补上桥接单测层

- **对标结论**: 参考仓库把"工具为什么不可用/失败后怎么办"写进错误本身
  (`buildDisabledMessage`: 工具名 + 缺哪个 flag + 怎么开 + 看 README)。本仓库此前是
  `错误: 缺少 id` 这类一句话 —— 客户端只能原样抛给用户。且 `controlGuard` 抛的是裸 Error,
  协议码在工具层丢失(只留在线协议的 Hub 层)。
- **改法**:
  - 新增 `bridge/src/errors.js`: 线上 `ERR.*` 码 → {文案, 下一步} + 业务码
    `LOCAL.{bad_args,no_entries,bad_payload,bad_state}`; 渲染固定为
    `错误[<code>]: <原因>` + `下一步: <动作>`(客户端可正则以码分流)。
  - `tools.js` 的 `fail(msg)` → `fail(code, msg)`; 15 处调用全部归码(8 处入参、
    5 处无数据、2 处形态异常带 `code`); `run()` 兜底走 `fromException`(带 code 按表、
    裸异常退化为 `error` 仍给下一步); `controlGuard` 抛错补 `ERR.FORBIDDEN`。
  - `bridge_status` 的未连接提示改为引用码表(消除第二份文案)。
- **两层证据**:
  - 源码级 `test/check_bridge_errors.js`: 码表 ↔ 线协议码一一对应、每条都有"下一步"、
    渲染格式、`tools.js` 禁止回退旧形态(`fail("...")` / 手写 `"错误: "` / 手写未连接文案)、
    所有 `fail()` 首参都必须是码。
  - 协议级 `bridge/smoke.mjs` 新增 `[6] 错误语义`: 真调 MCP 拿回包断言
    `bad_args`(条目已被挤出)/ `no_entries`(空抓包)/ `forbidden`(未开 --allow-control)
    三条码都到得了客户端。smoke 21 → **29 项**。
- **踩坑**: 想用"缺必填参数"验 `bad_args` 打不通 —— MCP SDK 先按 `inputSchema` 拒掉,
  请求到不了工具层; 必须用工具层自己的校验分支(条目不存在 / 空集)。

### 新增桥接单测层(覆盖盲区 #2)

- `bridge/src/{hub,archive}.js` 此前只有 smoke 的"扩展视角"端到端, 拒绝分支与落盘语义无人断言。
- 新增 `bridge/unit.mjs`(26 项, 不需要 Chrome): hub 的错令牌 / 协议版本不符 / 正常握手 /
  请求超时码 / 扩展回错误转 `ext_error` / 未开 --allow-control 的 `forbidden` / 未知方法 /
  断线时在途请求立刻 `not_connected` / 代理 QUERY 转发与按原 id 回包 / 未鉴权 query 被拒 /
  `ext.status` 广播; archive 的按天文件名 / 行内 batchId+archivedAt+entry / 非数组与空数组 /
  close 幂等 / 目录不可建时优雅降级。
- `test/run_all.js` 接入: `bridge/node_modules` 存在时追加 `bridge-unit` + `bridge-smoke`
  两个 suite(51/51), 未安装时打印 `SKIP(env)` 而不是伪装通过。

### 下一轮候选(更新)

1. **exporters/config 单测**: `bridge/src/exporters.js` 依赖扩展侧模块, 目前只被 smoke 间接覆盖;
   可加"导出口径"单测(空集/截断/字段缺失)。
2. **结果结构化**: 参考仓库无 `outputSchema`, 但若 SDK 支持 `structuredContent`,
   `net_list` / `bridge_status` 可给机读字段, 免去客户端二次 JSON.parse 文本。
3. **只读注解的实际收益验证**: 找 Claude Code 侧配置样例, 验证客户端确实按 `readOnlyHint` 放行。
4. **字段口径对拍**: 录制条目状态码/耗时/大小 vs 参考仓库 `src/tools/network.ts`。
5. **doctor 覆盖面**: 增加"令牌能否被 daemon 接受"的活体校验(需要临时连接一次)。

---

## R2 · v1.1.6 (2026-11-23)

### MCP 工具注解: 从"没有"到"协议层可见且被钉住"

- **对标结论**: 参考仓库 `src/tools/ToolDefinition.ts` 把 `annotations`(含 `readOnlyHint`)作为
  工具定义的必填字段, 27+ 个工具文件逐个声明; 本仓库 27 个 `registerTool` 全裸奔 ——
  客户端只能读 description 猜副作用, 打开 `--allow-control` 后「读控制台」与「点提交按钮」同等待遇。
- **改法(单一真相 + 漏声明即抛)**: `bridge/src/tools.js` 新增 `ANNOTATIONS` 表与
  `makeRegister(server)` 包装; 27 个工具全量声明 `readOnlyHint / destructiveHint /
  idempotentHint / openWorldHint`; 注解从表里取, 名字漏了在注册时直接抛错(不留静默通道)。
- **已复核的"读但需控制闸门"例外**: `page_snapshot` / `page_screenshot` / `page_wait` ——
  不改环境, 但要 debugger attach, 所以仍挂 `--allow-control`, 注解标只读。例外表写进测试。
- **破坏性口径**: `page_click`(可能提交表单)、`page_type`、`page_press`、`page_select`、
  `page_eval`(可执行任意 JS)、`chain_replay`(会真打后端)、`console_clear`、`tab_close`。
- **两层证据**:
  - 源码级: 新增 `test/check_bridge_annotations.js` —— 注解表 ↔ 注册集互为子集、`readOnlyHint`
    布尔、`destructive ⇒ 非只读`、控制闸门工具不得标只读(例外表显式)、不碰闸门的必须标只读、
    tool→method 落在 `bridge-protocol` 白名单。
  - 协议级: `bridge/smoke.mjs` 新增 `[5] 工具注解` —— 直接问 `tools/list`, 证明 27 个工具的
    注解真的到得了客户端, 且无"只读+破坏性"自相矛盾项。smoke 从 15 项涨到 **21 项**。
- **踩坑记录**: 全局把 `server.registerTool(` 替换成 `register(` 时, 把包装体内部的调用也换成了
  `register(` → 注册阶段自递归, 表现为 MCP `initialize` 超时(外部只看到超时, 不是报错)。
  修法 = 包装体内部保留 `server.registerTool`, server 用工厂注入。

### 下一轮候选(更新)

1. **错误语义对拍**: 参考仓库 `McpResponse.ts` / `ToolHandler.ts` 的错误文案与 `isError` 口径,
   逐工具审 `bridge/src/tools.js`(同类失败是否同一句式、是否都给下一步)。
2. **覆盖盲区**: `bridge/src/{hub,archive,exporters,config}.js` 仍只有端到端, 无单测。
3. **outSchema/结构化返回**: 参考仓库无 `outputSchema`(grep 为空), 但多数工具返回 JSON 文本;
   可评估给 `net_list` / `bridge_status` 等加 `structuredContent` 的收益(需 SDK 支持核对)。
4. **只读注解的实际收益验证**: 找 Claude Code 侧配置样例, 验证客户端确实按 `readOnlyHint` 放行。
5. **字段口径对拍**: 录制条目状态码/耗时/大小 vs 参考仓库 `src/tools/network.ts`。

---

## R1 · v1.1.5 (2026-11-23)

### 1. 环境性假红 → 修根因(不是修断言)

- **现象**: 全量回归 4/46 红(`test_regression` / `samples` / `check_options_page` / `check_pychain`), 与代码改动无关。
- **根因**: 测试用 `execSync(cmd, { shell: "bash" })` 跑 python 与 heredoc 轮询; 本机 PATH 里只有
  `git.exe`、没有 `bash` → `spawnSync bash ENOENT`。JMX 的 XML 良构校验另外借了
  `python -c "import xml.dom.minidom..."`。
- **修**: 新增 `test/lib/toolchain.js` —— python 3 探测(`WEBTOOLBOX_PYTHON` → `python` → `python3` → `py -3`)、
  `pyRun` 直呼解释器(无 shell)、`SKIP(env)` 记账(缺解释器显式标注, 不伪装通过)、`waitHttp`、
  `waitFor` 条件等待、`checkXml` 纯 JS 良构校验(接受面等价 `xml.dom.minidom.parse`)。
  三个测试文件改为直呼解释器 + 纯 JS XML 校验。
- **证据**: `47/47` 连跑 3 次全绿; `check_options_page` 单文件连跑 6 次全绿。

### 2. 假红背后的真缺陷(两处)

- **测试竞态**: `check_options_page` 用固定 `sleep(20ms)` 等 chrome.storage stub 的异步渲染链,
  并发跑时渲染晚到 → 6 跑 5 红(本轮实测)。改为 `waitFor` 等"用户可见完成点"(渲染产物/提示文案)。
- **产品竞态(真 bug)**: `options.js` 的 `addDomain` 用闭包里的 `domains` 回写清单,
  同一瞬间两次添加会丢一个(实测 `sub.example.com` + `example.com` 只剩后者)。
  修: 清单读-改-写统一过 `domainQueue` 串行锁, 锁内以存储为准重建; `removeDomain` / `editDomain` 同锁。
- **断言区分度证明**: 临时禁用锁 → 新断言红(`race-a.test.com` 丢失); 恢复 → 绿。

### 3. 桥接(bridge/)

- `bridge/package.json` 的 `doctor` 脚本指向不存在的 `src/doctor.js` → **实现**:
  12 项自检(node 版本 / 三个依赖可加载 / 协议契约 / 令牌来源 / daemon 端口 / 扩展 manifest 与
  `bridge-client.js`), 每条 FAIL 带"下一步"。实测: 无 daemon 时 11/12, 起 daemon 后 **12/12**。
- `bridge/smoke.mjs` 用相对路径 `"./src/index.js"` 按 cwd 解析 —— 在仓库根跑 README 写的
  `node bridge/smoke.mjs` 必然 `ECONNREFUSED 9399`(子进程 ENOENT 静默死)。改绝对 `ENTRY` 后
  **15 PASS / 0 FAIL**(README 原写"14 项"是旧数)。

### 4. 文档漂移(同轮修)

| 文件 | 漂移 | 现状 |
|---|---|---|
| `AGENTS.md` | 版本 1.0.82、34 项、结束卫生 34/34 | 1.1.5 / 47 项 / 47/47 + 新增"跨平台铁律" |
| `CLAUDE.md` | 版本 1.1.4、46 项 | 1.1.5 / 47 项 |
| `README.md` | smoke 14 项、缺 doctor | 15 项 + doctor 12 项 |
| `test/README.md` | 46 项、无 check_toolchain 行、无"禁固定 sleep"约定 | 47 项 + 新行 + 三条维护约定 |
| `bridge/README.md` | 14 项、无排障顺序 | 15 项 + 「排障顺序」节 |
| `manifest.json` | 1.1.4 | 1.1.5 |

### 5. 工程坑(写在前面, 避免下一轮重踩)

- **不许用 PowerShell 文本 cmdlet 回写源文件**: `(Get-Content -Raw).Replace(...) | Set-Content`
  会把 UTF-8 中文按 GBK 解码再写回, 直接毁文件(本轮 `bridge/smoke.mjs` 中过一次, 已从 git 字节恢复)。
  改文件只用编辑工具, 批量替换用 Node 脚本 + 字节级读写 + `MATCH != 1` 即中止。

### 6. 下一轮候选(按收益排序)

1. **MCP 工具注解缺失**: `bridge/src/tools.js` 的 28 个 `registerTool` 全无 `annotations`
   (参考仓库 `src/tools/*.ts` 普遍带 `readOnlyHint` 等), 也无 `outputSchema` —— 客户端无法在
   协议层区分只读/破坏性工具, 只能靠 `--allow-control` 全局开关。
2. **错误语义对拍**: 参考仓库 `ToolDefinition.ts` / `McpResponse.ts` 的错误文案(带下一步动作)与
   `isError` 使用口径, 逐工具审 `bridge/src/tools.js`。
3. **覆盖盲区**: `bridge/src/{hub,archive,exporters,tools,config}.js` 目前只有 `smoke.mjs` 端到端,
   无单测; 参考仓库 `tests/` 有独立单测。
4. **规则清单借鉴**: 参考仓库的 `eslint.config.js` / `prettier.config.js` 不能引入(零构建铁律),
   但可以抽成人工走查清单(如未使用参数、隐式 any 对应物、异步吞错)。
5. **字段口径对拍**: 录制条目状态码/耗时/大小与参考仓库 `src/tools/network.ts` 的字段语义。
