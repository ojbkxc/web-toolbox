# test/ —— e2e 走查回归集

历轮走查沉淀的 vm realm 端到端测试(原散落 `$TEMP/wtx_e2e`,v1.0.9 起正式入仓)。

## 跑法

```bash
node test/run_all.js          # 全量 85 项(含仓库根 test_regression / mock_bg_test / samples)
node test/check_xxx.js        # 单跑一个
```

全绿退出码 0;失败列出文件名与尾部输出。零依赖,只需 node。

## 覆盖清单

| 文件 | 主题 | 来源版本 |
|---|---|---|
| check_ai_body | CDP 对象 body 各下游环节归一化(读取层负责,AI/展示层降级不炸) + applyDynamics 空串动态值三分支不叠加/不误伤/保持空语义(v1.0.69) | v1.0.69 |
| check_aria | aria 可达性静态契约(列表/按钮/kv 块/状态栏 live/tab 结构/skillSel,原 check_trim_sync 场景 3) + tab 箭头键盘 vm 行为级 + 列表条目 Tab 停留点行为级(v1.0.60 a52-a62: Enter/Space 选中/非激活键不拦截/checkbox stopPropagation/双模式 aria 分流) | v1.0.60 |
| check_ai_full | callLlm 超时/abort 语义、AI 消息结构、断言上限 + 无 key 三态(空 key 不发 Authorization/有 key Bearer/opts.apiKey 空串覆盖) + diffTriage 真实快照形态(live {status,text} 映射不炸) + verdict↔diffTriage 截断口径对齐(尾部差异段进 prompt, v1.0.63) | v1.0.63 |
| check_ai_guard | 6 个 AI 入口 try/catch/finally 契约(按钮永锁/零提示防护) | v1.0.24 |
| check_aic3 | AI 关联链:表单体注入/多级链/旧数据下标兜底 + 镜像与 sidepanel 源码对拍(v1.0.64, 漂移即红) + JSON body 反斜杠转义序(v1.0.64 真修复) + query/url/路径段保留字符编码(v1.0.64) + 倒序链 JMX/PY 定位语义同拍(8b, v1.0.71) + 建链方向值校验自动纠向(refineChainDirection 四分支: 正向保留/反向交换/幻觉丢弃/响应缺失保守放行, v1.0.77) | v1.0.77 |
| check_aic_ui | 建链按钮 UI 行为:已有链直查不烧 LLM、查看器渲染 + JMX 生态骨架对拍(v1.0.60 场景 5: XML 栈配对/hashTree 配对/官方 defaults 同构) + renderChainPreview 数据流对拍(v1.0.65 场景 6: 可读名/删条目#序号兜底/corr ⚡ 标注) | v1.0.65 |
| check_assert_fix | 断言解析:extractChainJson 数组语义 | v1.0.7 |
| check_body_legacy | 旧数据 CDP 对象 body 加载归一化 | v0.3.9 |
| check_chain_body | 链路重放传对象 body 到页面 fetch | v0.3.9 |
| check_cookie_page | Cookie 页旅程 + localhost 精确授权 + cookies API 异常兜底 + getAll 后缀匹配语义(兄弟子域 host-only 不混入, RFC 6265 domain-match 收口, v1.0.62) + buildState 派生分支(持久 cookie expiresDate 透传/sameSite 去引号/Secure 派生, v1.0.63) + currentTab/授权链 API 异常兜底(6b: tabs.query 抛错零 unhandled rejection + ckMsg 错误可见, 与 getAll 异常同文案, v1.0.76) | v1.0.76 |
| check_duration_unit | CDP MonotonicTime(秒)→durationMs(毫秒) | v1.0.0 |
| check_early_buffer | SW 冷启动窗口(earlyBuffer)缓冲/补处理/域名过滤同路径 + containsPermission/refreshDomainCache 消息接线 + unmatchedHosts 生命周期/淘汰策略 + 换 tab 竞态窗口 | v1.0.52 |
| check_export_fields | 四导出器字段消费差异契约(保真 vs 压测语义, 防格式间静默漂移) | v1.0.52 |
| check_engine_edge | (9) 永远全录行为级: 静态资源 .css/.js、OPTIONS 预检、SSE(event-stream mime) 全部入列(引擎不做 skippable, 清洗只在导出层)、未授权域不入库但计入 unmatchedHosts; 入列乱序修复/关 tab pending 语义/截断/信封/pauseRecording 在途不丢半截/合帧批语义(同 tick 攒一批一次写+批内 FIFO) + pause/stop sendResponse 对称(storage.set 抛错走 {ok:false} 非永挂, v1.0.64) + 120 条大批量合帧无批上限退化(8b, v1.0.71) + clearHarvest 派生键清单含 pickIds(5 键全清+4 旧键回归锚+空信封落库, 10, v1.0.78) + 暂停→继续(同 tab)全链路(7b, #178 修复锚: attach 容错大小写不敏感/同 tab 继续不清 pending/在途横跨暂停窗口照常落库, v1.0.81) + 暂停→换 tab 继续 pending 清空(7c) + 重录全链引擎侧语义(7d: stop→clear→start 同 tab, 旧会话在途作废不混入新会话, v1.0.81) | v1.0.81 |
| check_export_clean | 导出净化产物级验证:HAR 1.2 required 字段齐(含 log.creator 与 content.size/mimeType、cache 对象)/超时 N/A/durationMs 正值分支(v1.0.59)/过滤词作用于导出 + 空 headers 条目不挂空 HeaderManager(对照组断言, v1.0.73) + JMX 挂 CSVDataSet/列 UDF 兜底/data.csv 伴生下载(e2e_popup 3a-3d2: v1.0.82) | v1.0.82 |
| check_single_source | 单源化探针:SESSION_MARKERS/60s 看门狗双 realm 词法可达 + SLOW_MS/MID_MS 声明+消费计数(无字面量残留) | v1.0.59 |
| (根)test_regression | 全模块单测(HAR content.size 按 UTF-8 字节计, 中文不被低报); 含导出净化 5c SSE 双形态判定(响应 mime + headers 兜底, v1.0.56)与 AUTH_RULES 零覆盖面(v1.0.55) + JSONL/HAR 保真同口径 5e(v1.0.71) + classifyDynamic 混合集首值优先 2b(v1.0.73) + JMX 主机变量化 HOST_n(UDF __P 值可 -J 覆盖/采样器 ${HOST_n} 引用/零字面量残留, v1.0.79-1.0.80) + PY main base_url 覆盖位(def/call 一致签名演化, v1.0.79) + 去重键语义/collectCsvData 录制值+占位符防御/header 列剔除/buildJmx CSVDataSet+UDF 兜底+冲突列过滤/CSV 模板双引号转义(5f, v1.0.82) | v1.0.82 |
| (根)samples/test_regression_samples | 样本库回归(结构样本合成 sample.invalid 保留域后也走 buildJmx, 不再 skip; 采样器数必须等于条目数): 15 样本全引擎消化 + meta 计数对齐 + 认证形态 + 引擎识别断言(4b) + auth 真实样本锚(4c) + SSE mime 样本锚(4e) + readJmx 反转义 roundtrip(4f, v1.0.70) + readJmx 变量化 domain 分支(4f2: ${HOST_n} 保留原样/path.query 不被伪 URL 解析污染, v1.0.79) + 变量分支怪形态(4f3: 部分引用走 splitUrl 兜底/__P 函数走变量分支, v1.0.80) | v1.0.80 |
| check_list_enhance | 列表增强:状态码颜色/过滤语义/单删联动(就近补选, v1.0.77)/cURL + 重放消费 textarea 编辑值(6a-6f: 编辑 body/头真实注入、坏行过滤、未编辑对照, v1.0.73) + 复选框全量修复(4b 场景: 清洗清死勾/勾选持久化 toolbox.pickIds/详情摘要/退出清键/空可见集全选护栏/重开恢复端到端, v1.0.77) + 清洗去重完全相同请求(4n: method+path+query+body 全同去重保首条/headers-响应-耗时不同不拆/状态明示含重复/pickIds 死 id 同清/GET-POST 同 path 不算重复, v1.0.82) | v1.0.82 |
| check_manual_prelude | manualPrelude 持久化与还原 + manual∩auto 优先级(manual=false 镇住 SSO auto 命中/refreshPrelude 重扫不覆盖, v1.0.64) | v1.0.64 |
| check_nonhttp_guard | 非 http(s) 页录制前置拦截(popup+sidepanel) + sidepanel"未配置域名"空态指引行为级(v1.0.74, #168 方向③) + 重录按钮前置拦截(4: chrome:// 页点「↻ 重录」不发起 stop/clear/start 录制链, v1.0.81) + 重录正向全链(6/6a/6b: http 页按序 stop→clear→start + tabId + 6c: 有数据时 confirm 取消不发起录制链) | v1.0.81 |
| check_options_page | options 旅程:域名增删改授权链/LLM 保存手势 + 删除域名撤销链路端到端(撤销 origins 与申请对称/granted 集同步/清单过滤/呈现层授权态, v1.0.70) + 并发添加串行锁(同 tick 两次 addDomain 都落库、既有域名不被吞) + 条件等待替代固定 sleep(v1.1.5) | v1.1.5 |
| check_page_eval_press | page.eval 值规约(Map/Set→对象数组、DOM 节点→[Node tag]、函数/循环引用/超深超量标记, 不再静默返回 {}) + page.press 按键表补 code/keyCode(表内键/单字符 KeyA-65/大写自动按 Shift/符号宁缺勿错/表外键与原型同名键都退回只传 key) + 快照标 [disabled](原生与 aria-disabled) + 只读/禁用/hidden 退回直接置空 + 编辑器吞键时兜底置空(clearedVia=direct, 经原型 setter) + page.type 逐字符保真模式(默认 insertText 不变/键按下-抬起顺序/非 ASCII 回落 insertText/回执 typedVia) + 死代码 bridgeSafeValue 已清(v1.1.4) | v1.1.4 |
| check_page_locate | 页面定位健壮性:命中测试(遮挡上报 covered/coveredBy、shadow 宿主反查、视口外不乱下结论) + 滚动落定轮询(元素移动时取落定坐标而非中途坐标) + 清空输入框走真实 Backspace(有内容才按键/Range 选中 contenteditable/非文本控件保持旧行为/清干净回执 clearedVia=key) + 悬停同源(vm 跑真实 bridge-client, 注入函数直调 + CDP 调用序列断言, v1.1.3) | v1.1.3 |
| check_poll_perf | popup/sidepanel 轮询移除+onChanged 推送语义/renderList 3000 条底线/签名启发式 + recState 徽章双面全枚举对账(v1.0.60) | v1.0.60 |
| check_pychain | PY 导出应用 AI 链(py_compile 过/无链不注入/PY↔JMX 提取变量名同源对拍, v1.0.62) | v1.0.62 |
| check_prompt_parity | skill 十技能 vs 独立按钮 prompt 零分叉(超限场景语义等价) + skill mdName 契约(11 值唯一/恰一次赋值/||skill 兜底+.md 后缀, v1.0.69) | v1.0.69 |
| check_replay_smoke | 重放单条看门狗/verdict 全路径/冒烟 deadline/租约/executeScript 注入失败逐条降级 + normalizeForCompare 短响应重叠指纹边界(长度参与指纹保底, v1.0.71) | v1.0.71 |
| e2e_full_user | background+sidepanel 双 realm 完整用户旅程 + 暂停在途不丢半截旅程面(v1.0.56 场景 9) + spChrome cookies 空 stub 预置(v1.0.63, 防 stub querySelectorAll 演进后 activate('ck') 触发 undefined 炸) + 悬空链 missing 回执旅程面(v1.0.66 场景 10: from 悬空可见回执, toId 挂集内真实条目——to 悬空是设计性 continue 不产回执) | v1.0.66 |
| check_seq_link | seq 动态值溯源合成链与 AI 链联动(含重复关联幂等) | v1.0.4 |
| check_skill_truncate | skill 路径截断明示/SKILL_MAX↔prompt 默认一致性/diag 环形缓冲边界(双上限+500 截断+循环引用 catch) | v1.0.12 |
| check_trim_sync | 起点裁剪 UI 三处清空路径同步 + 丢弃派生键(corr/chain/asserts/manualPrelude/chainResults)双轨完整性 + lastChainDiff 快照键随最近一次重放 + 引擎裁剪推送幽灵条目语义(不删保选中+自愈) + exportSet∩trim/filter/pick 五组合边界(端到端走真导出管线, v1.0.62) + AI 链回执端到端(v1.0.65 场景 5: applied/missing 逐行断, 按 URL 分流 mock) + btnSave SSE mime 主信号净化(v1.0.66 场景 6: 引擎真实条目形态, 单源修复的 sidepanel 面可达证明) + 同批多格式 stamp 时间戳一致性(6d, v1.0.71) + 清洗删选中条就近补选(trimHint 跟随, 1c/1c2, v1.0.77) + onChanged 清空分支 pickIds 清/模式保留/计数归零(2g2-2g4, v1.0.78)(aria 断言 v1.0.48 拆至 check_aria) | v1.0.78 |
| e2e_flow | 同页 9 script 串联加载全链(配域名→录制→导出) | v0.3.9 |
| e2e_popup | popup realm 快速导出 JMX/PY 全链 + 损坏信封明示(v1.0.56 场景 7) + siteReady 门槛/快捷添加域名端到端(9a-9j: 未配置藏录制/导出、停止按钮永在、有数据导出保留、一键添加授权+入列+按钮恢复、手势同步静态断言, v1.0.73) + domains 推送盲区修复行为级(9k1-9k4: options 删域名 popup 开着 → 推送后录制按钮藏, onChanged 监听体 stub 侧预捕获, v1.0.74) + refreshSafe unhandled rejection 兜底(10a-10c: tabs.query 抛错全程零 unhandled rejection + 静默降级保持提示文本 + 复原后正常路径还原, v1.0.75) | v1.0.75 |
| scan_conflicts | 同页串联 script 顶层声明撞名扫描(解析期杀全页防线) | v0.3.9 |
| (合并)check_ai_body2 | 并入 check_ai_body 作字符串 body 对照组 | v1.0.9 |

| check_toolchain | test/lib/toolchain.js 自检: checkXml 接受面(真 JMX 产物 + Apache JMeter 官方测试计划)与拒绝面(未闭合/不配对/重复属性/无引号/裸 &/多根/零根/文本裸 <)逐条对拍 + python 探测与 pyRun(非零退出即抛错) + waitHttp(真监听 true/关闭端口 false) + skip 记账不伪装通过(v1.1.5) | v1.1.5 |

| check_bridge_annotations | MCP 工具注解契约(源码级, 零依赖): ANNOTATIONS 表 ↔ register("...") 注册集互为子集、readOnlyHint 布尔、destructive⇒非只读、控制闸门工具不得标只读(已复核读例外仅 page.snapshot/screenshot/wait)、不碰闸门的必须标只读、tool→method 落在协议白名单(v1.1.6) | v1.1.6 |

| check_bridge_errors | 桥接错误语义契约: 线上 ERR.* 码 ↔ errors.js 文案表一一对应、每条错误必带"下一步"、渲染格式 `错误[code]: 原因`+换行+"下一步"、tools.js 不许回退旧形态(`fail("...")`/手写"错误: "前缀)、异常带 code 按码查表/裸异常退化仍给下一步(v1.1.7) | v1.1.7 |

| bridge/test-doctor | doctor 端到端(真起 daemon 看输出与退出码, 不信源码字符串): 无 daemon → 端口项红且其余检查跑完 + 退出码 1;有 daemon+正确令牌 → 退出码 0 且端口/令牌/活体握手/协议/包版本/归档六项 PASS;有 daemon+错令牌 → **恰好 1 项**红(不连坐)+ 含 unauthorized;参数错误 → 退出码 2 一行明说不甩栈(v1.1.42) | v1.1.42 |
| bridge/test-exporters | 导出口径单测(桥接层): pick 圈定语义/HAR 保真(不剔除静态·status=0·缺 duration→-1)/JMX·PY 压测口径(剔除静态/OPTIONS/SSE, 全噪音明确报错)/correlate 返回形态 + **单源证明**(猴补扩展 jmx.buildJmx / pyscript.buildPyScript / common.buildHar, bridge 输出必须立刻变)(v1.1.8) | v1.1.8 |

| check_doc_counts | 文档计数/版本/docs 目录闸门: docs/ 两指南存在且 README 有链、 README "共 N 个工具" ↔ 实现、文档间 .md 链接无断链、SECURITY.md 覆盖三道闸门等; 现算 suite 数(根 2+samples 1+test/ 发现+scan_conflicts+bridge 三层)并与 AGENTS/CLAUDE/test README/README/REVIEW 里的 "N 项/N/N/版本" 对拍, 不一致直接红(check_doc_counts 自身也算一个 suite)(v1.1.11) | v1.1.11 |

| check_bridge_schema | 工具 schema 可读性契约(源码级): 27 个工具的 inputSchema 顶层字段**全部**带 `.describe()`(模型靠它理解参数)、顶层 spread 只允许已描述的 filterShape、每个工具都有 title/description、`structured()` 调用与 outputSchema 成对、filterShape 自身字段也都带描述(v1.1.12) | v1.1.12 |

| check_tool_table | 工具表 ↔ 实现一致性: 27 个 register 工具必须都出现在 bridge/README「工具一览」表(v1.1.1 的 chain_replay/console_read/console_clear 曾长期漏在表外)、表中不得出现无实现的工具名、表格"需要 --allow-control"列(✓)必须与 tools.js 是否调 controlGuard 严格一致(标错会让模型以为免权限)(v1.1.13) | v1.1.13 |

| check_security_claims | SECURITY.md 的每条安全事实 ↔ 实现: 权限清单与 manifest 集合一致/无 host_permissions/optional 只两类协议、默认回环与 9280、令牌 0600+目录 0700+timingSafeEqual、控制类默认关闭且 hub 二次拦截、page_eval 标破坏性、扩展零依赖(根无 package.json)、"不做"清单在位(v1.1.17) | v1.1.17 |

| check_ai_hygiene | AI 管线两级脱敏: `scrubLong`(40+ 长串) + `scrubSensitiveKeys`(password/secret/sign 类键名, 值无论长短), token 类键名**不**进强脱敏(建链靠短 token 匹配); 表单体/JSON 体/URL query/驼峰键四形态覆盖(v1.0.95) | v1.0.95 |
| check_auto_chain | 轻量自动关联(autoDetectChain 不烧 LLM): 响应叶子值出现在后续请求 → 生成链并带 value 快照; 纯数字单号(≥8 位)/裸值 JSON/表单 k=v 三形态; mergeChain 去重(AI 链优先); 端到端到 buildJmx 的 JSONPostProcessor + CSVDataSet | v1.0.96 |
| check_console | 控制台日志采集: CDP RemoteObject 五形态归一化 / 环形缓冲有界(条数+字节) / 级别映射(log/warn/error) / exceptionThrown 归一化 / 与 harvest 完全隔离(清录制不影响日志) | v1.0.x |
| check_jmx_auto_assert | JMX 自动断言/报告组件: 每个采样器挂 ResponseAssertion(HTTP 200) + JSONPathAssertion(从录制响应推断成功指示字段, 不硬编码成功码) + 结果落盘组件 | v1.0.88 |
| check_jmx_setup_login | setUp 线程组登录模式: 全局只登 1 次(SetUpThreadGroup 单线程单循环)、前置链在 setUp 内、cookie 拼串进 `props.shared_cookie`、主线程组 HeaderManager 引用 `${__P(shared_cookie)}` | v1.0.91 |
| check_mcp_regression | MCP 回归能力工具: chain_replay/console_read/console_clear 注册与控制白名单放行/拦截、chain_replay 汇总组装不传完整响应体、console 读写转发、协议方法表与扩展分发一致性 | v1.1.1 |
| check_page_tab | 侧栏「页面」页签: pageDispatch 转发白名单(13 个 page.*/tab.* 方法放行, 导出/录制/关联/未知方法拦截)、桥接未加载时的明确报错、params 原样透传、HTML/JS 接线 | v1.0.x |
| check_ui_fixes | 侧栏 UI 细节: 格式卡片 label 双翻转根因(不再手动翻 checked)、清洗后计数/prelude UI 同步、勾选模式退出需确认、滚动位置保持 | v1.0.94 |
| check_unmatched_hint | 部分漏录诊断: `unmatchedHosts` 在 count>0 时也要提示(不再只在空列表时出现)、sidepanel/popup 两处提示条、updateUnmatchedHint 逻辑分支 | v1.0.92 |

| check_bridge_attach | 桥接 debugger 借用语义(vm 跑真实 bridge-client, chrome.debugger 全 stub): 自己 attach 成功 → 用完 detach 一次且 detach 时已挂 `toolboxBridgeOwnDetach` 标记;**录制引擎已 attach("Another debugger is already attached") → 借用且 detach 0 次**(不许把录制踹掉);其它 attach 错误 → 抛出指明原因;detach 抛错不影响结果;标记 1s 后自动摘除(v1.1.35) | v1.1.35 |

| check_bg_detach_guard | background 侧"桥接自发 detach 不清录制状态"守卫(vm 跑真实 background.js): 标记 `toolboxBridgeOwnDetach` 含该 tabId 时 onDetach 必须直接 return(**detach 0 次、不写 storage**);非桥接 detach(用户点黄条取消/被抢走)必须真的 detach 并清 attach 记录;标记缺失不抛错仍清理;无 tabId 事件不炸(v1.1.36) | v1.1.36 |

| check_ui_wiring | 页面 JS ↔ HTML 接线闸门(sidepanel/popup/options 三对): `$("literal")`/`getElementById("literal")` 的 id 必须存在于「HTML 静态 id ∪ JS 模板 id」(侧栏详情面板是 innerHTML 拼的);拼接形态(如 `$("pg"+tab)`)不参与判定以免误红;HTML id 不得重复;role=tab 的 aria-controls 必须指向真实面板;控件不得"既无引用也无内联事件"(v1.1.37) | v1.1.37 |

| check_ai_egress | AI 外发路径单源闸门: 10 个 `build*Prompt` 全部在 aireport.js 且**每个内部都调清洗**(aiSanitizeEntry/scrubLong/scrubSensitiveKeys);每处 `callLlm` 的宿主函数必须经 `build*Prompt`(options 的 testLlm 是唯一白名单例外, 且自检"例外不接触录制数据");build*Prompt 不许在别处复制;skill.js 委托 aireport 且不自己再洗一遍(防双份规则漂移)(v1.1.43) | v1.1.43 |

| check_no_internal_domains | 硬规则 4 的机器执行: 扫扩展运行时代码(根 js + 三页面 + manifest, 21 文件), 除 RFC 2606 保留域/产品自有域/扩展 API 命名空间外**不许出现真实或内网域名**;含**闸门自证**(真实域样例必须被判红、保留域必须放过)防"0 命中其实是正则失效"(v1.1.44) | v1.1.44 |

| check_repo_rules | AGENTS 硬规则 2/3/1 的机器执行: 测试里不许注释掉断言、不许框架级 .skip/.todo/xit(环境跳过 TC.skip 合法, 它会打 SKIP(env))、process.exit(0) 只能在末尾, 脚本/文档不许出现全量 add 用法, 仓库根无 package.json + 扩展运行时代码不引第三方 npm 包; **含闸门自证**(五组探针证明能分辨"描述规则"与"使用形态")(v1.1.46) | v1.1.46 |

| check_tool_coverage | MCP 工具**行为级**覆盖闸门: 27 个工具必须每个都在 bridge/smoke.mjs 里被**真调过**(callTool/call/J 三种形态, 且不算注释与文档提及) —— 工具表只证明"存在", 这里证明"工具→协议→扩展三段通、参数没被吞";另断言 smoke 有 `--allow-control` 启动分支(控制类不是只测 forbidden)、调用的工具名无幻影;含自证(v1.1.47) | v1.1.47 |

| check_user_journey | 用户旅程可用性(新人装完真的能用): manifest 必须有 commands(否则快捷键页是空的)且每条带 description;popup 五键齐;侧栏空态给"去配置";**popup 状态机按钮显隐行为级**(idle/recording/paused/未配置域名 四态, vm 跑真实 popup.js) —— 判据 style.display !== "none"(用 "" 表示显示)(v1.1.48) | v1.1.48 |

| check_sample_evidence | 样本证据链闸门: 15 个样本目录必须都在 INDEX.md 被提及(headless-recorder 曾漏在索引树外)、sample.json 必填 source/entries 且条数与 loader 实载一致、meta.url 不指向真实内网域(保留域/RFC·开源文档域白名单)、含闸门自证(v1.1.49) | v1.1.49 |

| check_sidepanel_handlers | 侧栏**动态生成按钮**的事件绑定完整性: innerHTML 模板里的每个按钮 id 必须在模板外有 `$()/getElementById` 绑定(漏绑=点击无反应的静默故障); 98 个绑定引用的 id 必须有声明面(HTML/字符串拼接模板/.id 赋值); addEventListener 同口径; 含闸门自证(v1.1.50) | v1.1.50 |

| check_options_bridge | 选项页「AI 桥接」区行为级(vm 跑真实 options.js, 双形态桩): 非法地址拦截且不落库、空令牌保存明示"不会连接"、有令牌 ✓、bridgeStatus 成功/失败/无响应三分流(透 lastError、给指引不静默空串)、已存配置回填 url/token/enabled(v1.1.52) | v1.1.52 |

| check_replay_verdict_matrix | verdict 判定矩阵: 断言**优先于状态码**(隐含契约, 有 asserts 时 500→200 也可 OK)/四类断言正反例(status/contains/not_contains/json_eq)/json_eq 降级(非 JSON 失败不炸、路径不存在失败、数组取首元素)/无断言回退(状态码优先于 body, 体差异 DIFF 不是 FAIL)/快失败(msg 报第一条)(v1.1.54) | v1.1.54 |

| bridge/test-reconnect | 桥接客户端重连语义(vm 跑真实 bridge-client.js + 可控 FakeWS): 连接失败→lastError 有值+alarm 重连(SW 生命周期安全);READY→connected, daemon 断开→重新 alarm;恢复→lastError 清空;hello 帧含令牌与协议版本(v1.1.55) | v1.1.55 |

| bridge/test-auth | **协议矩阵**(独立 daemon, 每规则一实例): 错令牌→unauthorized+不崩 / 版本不符→protocol_mismatch / 未鉴权 QUERY→拒绝 / **扩展身份发 QUERY→forbidden**(白名单: 仅代理) / 控制方法未开 --allow-control→错误带开启方式 / 正确配置→ready; ⑤需先挂假扩展(否则被"扩展未连接"先拦)(v1.1.56) | v1.1.56 |

| bridge/test-perf | 热路径性能基线(先量后断): checkXml 500条/300ms(基线16ms)、net_list 3000条UTF-8字节/100ms(2ms)、buildHAR 1000条中文/200ms(8ms)、buildJmx 500条全管线/400ms(15ms) —— 阈值=实测中位 8~25x, 只拦数量级退化不拦机器抖动(R15/R26 假红教训的正面做法)(v1.1.57) | v1.1.57 |

| check_tool_reference | 工具参考文档同步闸门: docs/tool-reference.md 必须与 `bridge/gen-tool-reference.cjs` 的生成产物**逐字节一致**(备份→重生成→比较→恢复; 不一致给前三行 diff 与重跑命令) —— 手改文档=漂移, 改工具参数后必须重跑生成器(v1.1.58) | v1.1.58 |

| check_record_all | **录制不变量「永远全录」**(AGENTS §1.7 唯一长期无闸门的一条): 2xx/3xx/4xx/5xx、任意 mime(html/png/SSE/空)、空响应(204)、超长体(截断不丢条目)全部入库; 仅 loadingFailed 与非授权域不入库。负向验证过: 注入"丢弃非 200"立刻 4 条红(v1.1.69) | v1.1.69 |

| check_assert_signature | **断言库签名一致性**(本仓有三种 ok 签名, 我用错过四次 → 输出 "OK true" 的假绿): 探测每个 suite 的签名形态(name 在前/cond 在前), 要求所有调用与之相符; 自证探针钉住判定逻辑(v1.1.79) | v1.1.79 |

| check_entry_health | **入口健康(秒级)**: 23 个运行时文件语法 + 真 spawn MCP 入口喂 initialize(抓 ReferenceError 类回归, 语法过≠能启动) + doctor --help 不挂住 + 扩展 6 个入口在 vm 可加载; 负向验证过(注入未定义变量 → 红)(v1.1.80) | v1.1.80 |

| check_rule_gate_map | **规则-闸门映射**(数据文件 `rule-gate-map.json` + 本闸门): AGENTS §1 每条 Never 必须登记"由哪些闸门管 + 负向验证方式"; 校验规则数一致/闸门文件真实存在且含断言/负向记录非空; 三组负向验证过(v1.1.88) | v1.1.88 |

| check_assert_count | **断言数量守恒**(基线 `assert-counts.json`, 当前 1810 条 / 72 suite): 任何 suite 的断言数少于基线即红(删断言必须显式改基线, 在 review 里可见); 基线登记的文件必须仍存在(防整文件删除); 新增断言不拦; 三组负向验证过(v1.1.92) | v1.1.92 |

| check_dom_escape | **扩展页面 DOM 注入面**: innerHTML 插值里不得出现裸远程字段(method/url/headers/AI 输出的 type 等); 判据精确到形态(转义/白名单包装/数字字段/纯计数/已构造片段/字面量三元都放行), 含 8 组自证 + escHtml 五字符覆盖; 负向验证过(回退任一处转义立刻红)(v1.1.96) | v1.1.96 |

| bridge/test-jmx-parse | **真实消费方解析**(本机有 java 才跑, 否则 SKIP 不伪装): 用 JDK 自带 XML 解析器(DocumentBuilder, 与 JMeter 同生态)真实解析导出物 —— 正常产物 / 含控制字符的原始数据 / XML 特殊字符全覆盖; 并强校验**手写 checkXml 与真实解析器判断一致**(不一致=手写判定有盲区)。负向验证过: 去掉 & 转义或控制字符剥离立刻红(v1.1.98) | v1.1.98 |

| bridge/test-py-run | **PY 导出物真实运行**(本机有 python 才跑, 否则 SKIP): 默认导出必须启动到"发请求"这一步(不因 base_url 为 None 而 TypeError)、失败原因必须是网络层、改 main 的 base_url 后仍能跑、step 用 `base_url or <origin>` 回退、注入尝试不产生 PWNED 副作用。负向验证过: 回退 base_url 语义立刻 5 条红(v1.1.99) | v1.1.99 |

| check_diag_bounds | **AGENTS §1.7 第三项: 诊断日志有界**(R82 只补了全录/时间序, ③ 此前零闸门): 常量就是承诺值(1000 条/512KB)/条数界真触发/字节界真触发(长消息下条数先于 1000 停下, 否则是死代码)/单条 message 截 500/字段集仅元信息/坏输入不抛/闸门自证用 999 与 1001 两侧样本证明界在 1000。三项负向验证过(v1.2.3) | v1.2.3 |

| check_skill_set | **AI 技能集守恒**(AGENTS §5 ask-first): 技能 name 集合必须与基线 `skill-set.json` 一致 —— 新增/移除都会红, 必须在同一次改动里更新基线(那次更新就是"显式声明", 会出现在 review diff 里); 另验每个技能都声明 buildPrompt。实测注入第 11 个技能时其余 4 个 AI 闸门全绿, 只有它能拦(v1.2.4) | v1.2.4 |

| check_doc_commands | **文档里的命令必须真能跑**: 扫 12 份文档里所有 `node <file>` 形态, 目标文件必须存在(占位符 `xxx`/`<...>` 豁免); 实测抓出过 `docs/tool-reference.md` 头部仍写 `.js` 而生成器已改名 `.cjs` 的死链。含 2 组闸门自证(v1.2.9) | v1.2.9 |

| check_readme_tree | **README 文件结构树 ↔ 实际文件**: 树里每项必须存在(幽灵)、实际关键项(.js/.json/目录)必须都画进树(漏画)、树里不得写死 check_*/e2e_* 计数(会漂)。实测曾漏画 bridge/、samples/、bridge-client.js 等关键项, 且把 check_* 计数写死成旧值(v1.3.0) | v1.3.0 |

## 维护约定

- 文件名保持 `check_*.js` / `e2e_*.js` 前缀,`run_all.js` 自动发现;禁用 `_` 开头命名(Chrome 拒载扩展目录下此类文件)
- 仓库根路径一律 `const ROOT = require('path').resolve(__dirname, '..')`,禁止绝对路径
- 断言式(ok/pass/fail + 退出码),不要纯 console.log 观察式——run_all 靠退出码判定
- **异步测试的 `process.exit` 必须放在 IIFE 尾部**(await 之后)——放在外层主线程不等异步体就退出,断言静默没跑还报 PASS(check_seq_link v1.0.17 实际炸过:7 条集成断言从未执行)
- vm realm 测试断言"加载后状态"前必须显式 `await vm.runInContext('loadHarvest()')`——storage.get 异步回调链,等 30~50ms 不保证 entries 已置入
- 测试文件与被测源文件同改同提交;新增能力先补测试再收尾
- scan_conflicts 殿后:它约束"新增 script 文件"动作本身,新增 sidepanel/popup script 后必跑
- **改完 suite 数或版本必须同步五份文档**(v1.1.11): AGENTS/CLAUDE/test README/README/REVIEW; `check_doc_counts` 会红, 别手改数字凑绿
- **禁止 shell 出去调 bash/python**(v1.1.5):Windows PATH 里通常只有 git.exe, 硬编码 `{ shell: "bash" }` 会让整套环境性假红;一律走 `test/lib/toolchain.js`(`pyRun` 直呼解释器, 探测不到记 `SKIP(env)`)
- **禁止固定 `sleep(N)` 当同步原语**(v1.1.5):异步链等不到就假红(check_options_page 曾 6 跑 5 红);用 `waitFor` 等"用户可见完成点"(渲染产物/提示文案), 超时后断言给出真实失败信息
- **错误文案只许来自 `bridge/src/errors.js`**(v1.1.7): 工具层 `fail(code, msg)` 首参必须是码(LOCAL.*/ERR.*), 渲染统一为 `错误[code]: 原因` + `下一步: 动作`; 新增码要同时进表, 由 check_bridge_errors 兜底
- **验证 SKIP(env) 分支**: `WEBTOOLBOX_NO_PYTHON=1 node test/run_all.js` 强制"没有 python 解释器",
  用来实跑那些平时走不到的降级路径(本机同时有 python 与 `py` launcher, 光从 PATH 摘 "python" 段
  并不能真正模拟缺解释器)。期望: 相关项打 `SKIP(env)` + 退出码 0, 摘要里列出跳过项。
- XML 良构校验用 `checkXml`(纯 JS, 接受面等价 `xml.dom.minidom.parse`), 不再为一条断言引入外部解释器
