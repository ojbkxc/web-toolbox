# 更新记录

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
