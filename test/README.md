# test/ —— e2e 走查回归集

历轮走查沉淀的 vm realm 端到端测试(原散落 `$TEMP/wtx_e2e`,v1.0.9 起正式入仓)。

## 跑法

```bash
node test/run_all.js          # 全量 36 项(含仓库根 test_regression / mock_bg_test / samples)
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
| check_engine_edge | 入列乱序修复/关 tab pending 语义/截断/信封/pauseRecording 在途不丢半截/合帧批语义(同 tick 攒一批一次写+批内 FIFO) + pause/stop sendResponse 对称(storage.set 抛错走 {ok:false} 非永挂, v1.0.64) + 120 条大批量合帧无批上限退化(8b, v1.0.71) + clearHarvest 派生键清单含 pickIds(5 键全清+4 旧键回归锚+空信封落库, 10, v1.0.78) + 暂停→继续(同 tab)全链路(7b, #178 修复锚: attach 容错大小写不敏感/同 tab 继续不清 pending/在途横跨暂停窗口照常落库, v1.0.81) + 暂停→换 tab 继续 pending 清空(7c) + 重录全链引擎侧语义(7d: stop→clear→start 同 tab, 旧会话在途作废不混入新会话, v1.0.81) | v1.0.81 |
| check_export_clean | 导出净化产物级验证:HAR 1.2 required 字段齐/超时 N/A/durationMs 正值分支(v1.0.59)/过滤词作用于导出 + 空 headers 条目不挂空 HeaderManager(对照组断言, v1.0.73) + JMX 挂 CSVDataSet/列 UDF 兜底/data.csv 伴生下载(e2e_popup 3a-3d2: v1.0.82) | v1.0.82 |
| check_single_source | 单源化探针:SESSION_MARKERS/60s 看门狗双 realm 词法可达 + SLOW_MS/MID_MS 声明+消费计数(无字面量残留) | v1.0.59 |
| (根)test_regression | 全模块单测; 含导出净化 5c SSE 双形态判定(响应 mime + headers 兜底, v1.0.56)与 AUTH_RULES 零覆盖面(v1.0.55) + JSONL/HAR 保真同口径 5e(v1.0.71) + classifyDynamic 混合集首值优先 2b(v1.0.73) + JMX 主机变量化 HOST_n(UDF __P 值可 -J 覆盖/采样器 ${HOST_n} 引用/零字面量残留, v1.0.79-1.0.80) + PY main base_url 覆盖位(def/call 一致签名演化, v1.0.79) + 去重键语义/collectCsvData 录制值+占位符防御/header 列剔除/buildJmx CSVDataSet+UDF 兜底+冲突列过滤/CSV 模板双引号转义(5f, v1.0.82) | v1.0.82 |
| (根)samples/test_regression_samples | 样本库回归: 15 样本全引擎消化 + meta 计数对齐 + 认证形态 + 引擎识别断言(4b) + auth 真实样本锚(4c) + SSE mime 样本锚(4e) + readJmx 反转义 roundtrip(4f, v1.0.70) + readJmx 变量化 domain 分支(4f2: ${HOST_n} 保留原样/path.query 不被伪 URL 解析污染, v1.0.79) + 变量分支怪形态(4f3: 部分引用走 splitUrl 兜底/__P 函数走变量分支, v1.0.80) | v1.0.80 |
| check_list_enhance | 列表增强:状态码颜色/过滤语义/单删联动(就近补选, v1.0.77)/cURL + 重放消费 textarea 编辑值(6a-6f: 编辑 body/头真实注入、坏行过滤、未编辑对照, v1.0.73) + 复选框全量修复(4b 场景: 清洗清死勾/勾选持久化 toolbox.pickIds/详情摘要/退出清键/空可见集全选护栏/重开恢复端到端, v1.0.77) + 清洗去重完全相同请求(4n: method+path+query+body 全同去重保首条/headers-响应-耗时不同不拆/状态明示含重复/pickIds 死 id 同清/GET-POST 同 path 不算重复, v1.0.82) | v1.0.82 |
| check_manual_prelude | manualPrelude 持久化与还原 + manual∩auto 优先级(manual=false 镇住 SSO auto 命中/refreshPrelude 重扫不覆盖, v1.0.64) | v1.0.64 |
| check_nonhttp_guard | 非 http(s) 页录制前置拦截(popup+sidepanel) + sidepanel"未配置域名"空态指引行为级(v1.0.74, #168 方向③) + 重录按钮前置拦截(4: chrome:// 页点「↻ 重录」不发起 stop/clear/start 录制链, v1.0.81) + 重录正向全链(6/6a/6b: http 页按序 stop→clear→start + tabId + 6c: 有数据时 confirm 取消不发起录制链) | v1.0.81 |
| check_options_page | options 旅程:域名增删改授权链/LLM 保存手势 + 删除域名撤销链路端到端(撤销 origins 与申请对称/granted 集同步/清单过滤/呈现层授权态, v1.0.70) | v1.0.70 |
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

## 维护约定

- 文件名保持 `check_*.js` / `e2e_*.js` 前缀,`run_all.js` 自动发现;禁用 `_` 开头命名(Chrome 拒载扩展目录下此类文件)
- 仓库根路径一律 `const ROOT = require('path').resolve(__dirname, '..')`,禁止绝对路径
- 断言式(ok/pass/fail + 退出码),不要纯 console.log 观察式——run_all 靠退出码判定
- **异步测试的 `process.exit` 必须放在 IIFE 尾部**(await 之后)——放在外层主线程不等异步体就退出,断言静默没跑还报 PASS(check_seq_link v1.0.17 实际炸过:7 条集成断言从未执行)
- vm realm 测试断言"加载后状态"前必须显式 `await vm.runInContext('loadHarvest()')`——storage.get 异步回调链,等 30~50ms 不保证 entries 已置入
- 测试文件与被测源文件同改同提交;新增能力先补测试再收尾
- scan_conflicts 殿后:它约束"新增 script 文件"动作本身,新增 sidepanel/popup script 后必跑
