# web-toolbox 开发者指南

## 项目概览

**Chrome MV3 扩展**（纯 JavaScript、零构建、零 npm 依赖）：内网自动化的辅助工具箱。
录制 → AI 分析 → 自动关联 → 导出 JMeter/Python/JSONL/HAR → 就地冒烟，替代 BlazeMeter
Chrome 扩展且数据不出本机。目标域名完全可配置——默认对任何站点无权限。

- **远端**：https://github.com/ojbkxc/web-toolbox（main 直接 push，无 PR 流程）
- **安装**：`chrome://extensions` 开发者模式加载本目录，源码即产物（没有 build 步骤）
- **版本**：`manifest.json` 的 `"version"`（当前 1.0.82）

## 核心验证方式：node 走查回归（不是 GitHub Actions）

本仓库没有 CI workflow，回归门禁是本地零依赖测试：

```bash
node test/run_all.js      # 全量 34 项，全绿退出码 0
node test/check_xxx.js    # 单跑某个
```

- **完成态定义 = 34/34 PASS**。每次改动收尾必须跑全量；失败修根因，禁止跳过/放宽断言。
- 新增行为必须配套 `test/check_*.js` 走查（vm realm 端到端风格，见 `test/README.md`）。
- 通用化规则（如清洗判定、关联算法）**必须用 `samples/opensource/` 真实开源样本验证**，
  不许只拿 `samples/known/` 的 KTKI 自造样本自证。

## 目录速览

| 路径 | 内容 |
|---|---|
| `background.js` | service worker：录制引擎（chrome.debugger、环形诊断日志） |
| `sidepanel/` | 工作台：查看/过滤/重放/关联/导出/AI 全部在侧栏 |
| `popup/` | 极简启动（开始/暂停/停止 + 打开侧栏） |
| `options/` | 域名授权配置 + AI 端点配置（地址/模型/Key 三项可配） |
| `common.js` | 各页面与 worker 共享的工具函数 |
| `jmx.js` `pyscript.js` | JMeter / Python 脚本导出器 |
| `replay.js` `correlate.js` | 链路重放（回归 diff）/ 自动关联（动态值参数化） |
| `aireport.js` `skill.js` `auth.js` | AI 报告/技能选择器 / 登录前置识别 |
| `test/` | 34 项走查回归（零依赖，只需 node） |
| `samples/` | 样本库：known(自造) + opensource(真实开源样本) |

## 开发规范

完整规则见 [AGENTS.md](./AGENTS.md)。要点：

1. **零依赖铁律**——不引 npm 包、不加构建链、不上 TS；源码即产物
2. **数据卫生管线不可绕过**——Cookie/Authorization 永不外发 LLM，长 token 打码、
   body/响应截断在扩展侧统一执行
3. **域名授权模型不可破坏**——`optional_host_permissions` 按需授权，禁止硬编码域名
4. **录制不变量**——永远全录、按请求时间序入库；过滤/勾选/清洗只影响显示与导出
5. **同一判定两处生效**——一键清洗（删源数据）与导出自动净化共用同一套规则
6. 手术式修改：只改必须改的，风格对齐邻近代码（中文注释 + 紧凑 JS）
7. 只 add 自己改的文件，禁止 `git add -A`；commit 信息中文说清"改了什么、为什么"
8. 功能性改动 bump manifest version（第三位递增）+ 同步 README 模块表

## 常见问题

### Q: 为什么没有 GitHub Actions CI？
A: 纯 JS 零依赖扩展，node 走查在本机 30 秒跑完 34 项，本地 `test/run_all.js` 就是 CI。

### Q: 怎么手动冒烟？
A: `chrome://extensions` 重新加载扩展 → 配置一个域名 → 录制 → 侧栏过滤/导出，走一遍核心链路。

### Q: AI 端点怎么配？
A: 选项页 "AI 分析接口" 区：地址/模型/Key 三项全可配，默认 `http://127.0.0.1:8787/v1` +
`qwen3.7-plus`（本地代理，空 Key 直接可用）。

### Q: samples 什么时候要动？
A: 只有新增/调整"通用判定规则"（清洗、关联、登录识别）时才需要加开源真实样本验证。
