# AI 技能参考(Skills)

> 本文件由 `node bridge/gen-skills-doc.cjs > docs/skills.md` **生成**, 不要手改。
> 源头是 `skill.js` 的技能表(name/desc), 漂移会在 `check_doc_counts` 闸门红。

侧栏「AI 技能」选择器里的十项技能, 每项对应一种 `build*Prompt`(见 aireport.js, 全部
自带数据卫生管线)。技能以 `run_skill` 触发, 与独立按钮 **prompt 零分叉**(`check_prompt_parity` 钉住)。

| 技能 | 说明 |
|---|---|
| `report` | 流量报告: 业务流程拆解+接口依赖+风险 |
| `diagnose` | 错误诊断: 自动分析第一条失败请求 |
| `chain` | 参数建链: 跨接口参数传递自动关联 |
| `doc` | 接口文档: OpenAPI 风格, 贴 wiki |
| `assert` | 断言生成: 接口成败判定规则 |
| `perf` | 冒烟解读: 判瓶颈, 给调优建议 |
| `inventory` | 接口清单: Markdown 表格 |
| `sensitive` | 敏感扫描: 查 token/密码/隐私泄漏 |
| `session` | 会话回填: 找登录特征, 反哺识别规则 |

## 边界与卫生

- 每个技能的 prompt 构造都经 `aiSanitizeEntry`(剔 Cookie/Authorization、长 token 打码、
  body/响应截断)—— 由 `test/check_ai_egress.js` 钉住, 不存在旁路。
- `sensitive` 是**只读扫描**(查泄漏), 不修改任何数据。
- `session` 的识别规则会反哺 `auth.js` 的登录前置判定(`manualPrelude` 优先级高于自动)。

