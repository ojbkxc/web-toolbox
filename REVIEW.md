# 评审记录 —— 对标 chrome-devtools-mcp

参照: `E:\github\chrome-devtools-mcp-main\chrome-devtools-mcp-main`(Chrome DevTools MCP, TS + puppeteer)。
目标: 持续评审并完善本仓库; 每轮必须"取证 → 修根因 → 回归 → 记录", 不许只写结论。

**门禁(2026-11-23 起)**
- 扩展回归: `node test/run_all.js` → **76/76 PASS**(内含桥接 unit/exporters/doctor/smoke)
- 桥接端到端: `node bridge/smoke.mjs` → **74 PASS / 0 FAIL**(任意 cwd)
- 桥接单测: `node bridge/unit.mjs` → **71 PASS / 0 FAIL**; `node bridge/test-exporters.mjs` → **46 PASS / 0 FAIL**
- 桥接自检: `node bridge/src/doctor.js` → **18/18 PASS**(需先起 daemon; 含监听地址/活体握手/协议与包版本一致性/归档目录/令牌权限)

---

> **归档说明(v1.1.53)**: R1-R20 的完整过程已移入 git 历史; 以下只留一行索引。
> 它们的根因、修法与证据已沉淀到 CHANGELOG.md、各测试文件注释与闸门本身。
> 近段(R21+)保留全文。
- R1 · v1.1.5 (2026-11-23)  —  : 全量回归 4/46 红(`test_regression` / `samples` / `check_options_page` / `check_pychain`), 与代码改动无关。 - 
- R2 · v1.1.6 (2026-11-23)  —  改法(单一真相 + 漏声明即抛)
- R3 · v1.1.7 (2026-11-23)  —  29 项**。 - 
- R4 · v1.1.8 (2026-11-23)  —  单源证明**: 猴补扩展侧 `jmx.buildJmx` / `pyscript.buildPyScript` / `common.buildHar`,     bridge 输出必须
- R5 · v1.1.9 (2026-11-23)  —  结构化返回(对标参考仓库的 machine-readable 输出)
- R6 · v1.1.10 (2026-11-23)  —  `reqBytes`/`respBytes` 语义错
- R7 · v1.1.11 (2026-11-23)  —  动机**: R1 发现 AGENTS 写"34 项/1.0.82"而实际是 46 项/1.1.4。这类漂移每轮都要手工追,   而且它骗的是
- R8 · v1.1.12 (2026-11-23)  —  16 个输入字段没描述
- R9 · v1.1.13 (2026-11-23)  —  实测漂移**: `bridge/README` 的「工具一览」表停在 v1.1.0, 
- R10 · v1.1.14 (2026-11-23)  —  一行提示 + 退出码 2
- R11 · v1.1.15 (2026-11-23)  —  17/17** |  ### 下一轮候选(更新)  1. 
- R12 · v1.1.16 (2026-11-23)  —  "不做"清单**(不做进程隔离/不做加密存储/不隐藏 debugger 黄条), 避免读者高估边界;   - 报告口径(附 doctor 输出、敏感值先打码)。 - 
- R13 · v1.1.17 (2026-11-23)  —  18/18**。  ### 证据  | 层 | 命令 | 结果 | |---|---|---| | 全量回归 | `node test/run_all.js` | 
- R14 · v1.1.18 (2026-11-23)  —  `net_list` 边界(smoke +3 项)
- R15 · v1.1.19 (2026-11-23)  —  断言(不测绝对性能, 测三件会退化的事)
- R16 · v1.1.20 (2026-11-23)  —  `net_get` 截断
- R17 · v1.1.21 (2026-11-23)  —  原状**: `samples/opensource/apache-jmeter`(3 条) 与 `taurus/jmx-structure`(23 条) 是从   `.jmx` 解析出的
- R18 · v1.1.22 (2026-11-23)  —  信息不因结构化而丢**;   - `response` 内容与之前一致(截断时仍带那句说明, 人读也清楚)。 - 
- R19 · v1.1.23 (2026-11-23)  —  实测缺口**: `test/README` 自称"覆盖清单", 但 49 个走查文件里 
- R20 · v1.1.24 (2026-11-23)  —  等批**: 200KB(字符)→ 字节口径修正(录制引擎配额裁剪, AGENTS §5 ask-first)。 2. 

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
