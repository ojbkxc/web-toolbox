# AGENTS.md — web-toolbox

> 给 AI 编码代理的仓库指南。规则分三级：**Never(禁止) / Ask first(先问) / 默认自主**。
> 每条硬规则都对应真实踩过的坑，不要试图绕过。

## 0. 项目速览(新会话必读)

**web-toolbox** 是 Chrome MV3 扩展（纯 JS，零构建、零 npm 依赖），内网自动化辅助工具箱：
录制(chrome.debugger) → AI 分析 → 自动关联 → 导出 JMeter/Python/JSONL/HAR → 就地冒烟。
零业务逻辑、只产出数据；目标域名完全可配置（`optional_host_permissions`，不配域名对任何站点无权工作）。

- **仓库**：https://github.com/ojbkxc/web-toolbox（main 分支，直接 push，不走 PR）
- **形态**：`manifest.json` v3，版本号在 manifest `"version"`（当前 1.0.82）
- **入口文件**：
  - `background.js` — service worker，录制引擎（chrome.debugger attach/网络事件/环形诊断日志）
  - `sidepanel/` — 工作台（查看/过滤/重放/关联/导出/AI 全在侧栏）
  - `popup/` — 极简启动（开始/暂停/停止 + 打开侧栏）
  - `options/` — 域名授权配置 + AI 端点配置（地址/模型/Key）
  - `common.js` — 共享工具（所有页面与 worker 共用）
  - `jmx.js` JMeter 导出 / `replay.js` 重放 / `correlate.js` 自动关联 / `pyscript.js` PY 导出
  - `aireport.js` AI 报告/诊断/建链/断言 / `skill.js` AI 技能 / `auth.js` 登录前置识别
- **测试**：`test/run_all.js`（`node test/run_all.js`，34 项全绿退出码 0，零依赖只需 node）
- **样本库**：`samples/`（`known/` 自造 KTKI 样本 + `opensource/` 开源项目真实样本——
  **通用化规则必须用开源样本验证**，不许只拿 KTKI 样本自证）

## 1. Never(硬性禁止，违反即返工)

1. **禁止引入任何构建链/npm 依赖**。项目零依赖、源码即产物，`chrome://extensions`
   加载本目录即用。新增 `package.json`/bundler/TS 一律不允许。
2. **禁止在测试里放行未过的断言**；不许 `.skip`/注释掉断言/放宽阈值让 CI 变绿。
   测试是回归走查的唯一防线。
3. **禁止 `git add -A` / `git add .`**：只 add 自己本次改动的文件（可能存在并行会话改动）。
4. **禁止把真实内网域名、Cookie、API Key 写进任何入库文件**。samples 用脱敏样本；
   新增样本先过敏感字段扫描。
5. **禁止破坏数据卫生管线**：发 LLM 前的 Cookie/Authorization 剔除、长 token 打码、
   body/响应截断规则在扩展侧统一执行——任何 AI 功能改动都要过这条管线，不许绕过。
6. **禁止破坏域名授权模型**：`optional_host_permissions` 按需授权是核心安全设计，
   不许硬编码域名、不许默认申请 `*://*/*`。
7. **禁止破坏录制引擎不变量**：录制永远全录（过滤/勾选/清洗只影响显示与导出）、
   条目按请求时间序入库（时间线不失真）、诊断日志有界(1000 条/512KB 仅元信息)。

## 2. 验证纪律（本仓库 CI = 本地 node，因为没有 Actions）

- **完成态定义 = `node test/run_all.js` 全绿(34/34)**。这是唯一回归门禁。
  改动收尾必须跑它；失败只修根因，不许跳过失败项。
- 单跑：`node test/check_xxx.js`；新增行为必须配套新增 `test/check_*.js` 走查
  （命名撞名扫描 `scan_conflicts.js` 殿后，script 文件不许撞名）。
- 走查测试风格：vm realm 端到端（见 `test/README.md`），历轮走查沉淀入库，不外挂 $TEMP。
- 无 lint 工具链：风格对齐邻近代码（现有源码是中文注释 + 紧凑 JS）。
- 手动冒烟：改 UI 后在 `chrome://extensions` 重新加载扩展走一遍核心流程（录制→导出）。

## 3. 架构要点（改动前脑内过一遍）

- **三层结构**：background(引擎) → chrome.storage(会话持久) → sidepanel(展示/操作)。
  worker 重启即丢内存态，录制状态必须可从 storage 恢复。
- **导出集语义**：勾选集 > 过滤可见集 > 全量，导出/AI/关联/重放统一用这套圈定。
- **同一套判定规则两处生效**：一键清洗（删源数据）与导出自动净化（只影响导出集）必须
  共用同一套预检/静态资源/SSE 判定——改判定规则两边同步。
- **AI 调用**：`callLlm` 带 120s 超时；三态 Key（空 Key 不发 Authorization）；端点/模型/
  Key 全部来自选项页配置，代码里不许写死。
- **JMX/PY 导出**：登录前置(OnceOnlyController/IfController)、主机变量化(`${HOST_n}`)、
  参数链提取器——导出的脚本要开箱能跑（`jmeter -n -t` / `python xx.py`），导出后必须
  有走查测试覆盖新逻辑。
- **版本节奏**：每次功能性改动 bump `manifest.json` 的 version（小数第三位递增），
  README 模块表同步。

## 4. 自动迭代闭环

```
理解任务 → 就绪判定 → 手术式实现 → 新增/更新走查 → run_all 全绿 → commit/push main
              ↑                                                        │
              └──────────── 修根因，盲试 ≤2 次后停下报告 ←── 测试红 ──┘
```

1. **就绪判定**：非平凡改动先写简短方案（目标/取舍/放弃项）再动手。
2. **手术式修改**：只改必须改的；不顺手重构、不做格式化改动；匹配邻近风格。
3. **push 方式**：origin 已内嵌 token，直接 `git push origin main`；
   禁止交互式凭据管理器（无人值守会永久挂起）。
4. **commit 信息**：中文，说清"改了什么、为什么"（与现有历史风格一致）。
5. **不许宣称被阻塞**：没实际尝试就说 "not attempted"；被挡下要引用真实报错。
6. **结束卫生**：不留未提交改动；最终答复带回归结论（34/34 PASS）或 commit SHA。

## 5. Ask first(先问再做)

- 新增 `chrome.permissions` / host 权限条目（影响用户安装信任面）。
- 动 manifest.json 的权限/入口结构（background/side_panel/options 挂载）。
- 新增 AI 技能（涉及 prompt 设计与数据卫生边界）。
- 改 `background.js` 的录制引擎核心（attach/detach/缓冲/配额裁剪逻辑）。
- 任何删除超过 100 行的批量清理。

## 6. 参考文件

- 功能全景与使用说明：`README.md`（模块表、数据卫生、导出格式说明）
- 测试规范与覆盖清单：`test/README.md`
- 样本库：`samples/INDEX.md`、`samples/README.md`
