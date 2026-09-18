# samples 索引 — 通用引擎验证样本库

> 原则：**通用性必须用开源/多样样本证明**。`known/` 是本地录制（回归基线，非通用性证据），`opensource/` 是真实开源样本（通用性证据，全部标注出处）。

## 认证形态覆盖矩阵

| 认证形态 | 样本 | 形态特征 |
|---|---|---|
| **cookie 会话 + token** | `known/ics_harvest` | `login/option → getSetProfile → 组织/角色/用户信息`，`isc-token` 头 + Cookie |
| **cookie + CAS 票** | `known/ktki_detail` | `?ticket=ST-xxx` 进入，`x-gr-orgcode` 组织上下文（meta 标注的 `startTime`/`orgCode` 在 jsonl 实体里不存在——yaml 原件字段未随 jsonl 化保留，勿当作可断言面，v1.0.62 对账） |
| **Basic Auth** | `opensource/apache-jmeter` (Http4ImplPreemptiveBasicAuth) | `<AuthManager>` + `${login}/${password}` |
| **Digest Auth** | `opensource/apache-jmeter` (Http4ImplDigestAuth) | Digest 挑战-响应 |
| **Cookie Manager** | `opensource/apache-jmeter` (TestCookieManager) | `<CookieManager>` cookies 集合结构 |
| **form 登录 (CSV 参数化)** | `opensource/taurus/csv-login` | `username/password` 从 CSV 读取，`${username}` |
| **URL 内嵌凭证 + Basic b64** | `opensource/k6` (http_basic_auth) | `user:passwd@httpbin.org` 与 `Authorization: Basic` 两种 |
| **JWT / 自定义 token** | `opensource/k6` (jwt.js) | 自行拼 `Bearer ${token}` |
| **OAuth2 授权码流** | `opensource/oauth2-authcode` (RFC 6749 §4.1) | `/authorize → /token → Bearer`，access_token 跨请求引用 |
| **无认证公开站** | `opensource/taurus/blazedemo` | 下单三步流，登录识别**不得误报** |
| **SSE 流（净化判定）** | `opensource/oreilly-eventsource` | 同批 API JSON + `text/event-stream` 端点——`isSkippable` mime 主信号（v1.0.56 死分支修复）的真实样本锚，见 `test_regression_samples.js` 4e |
| **body 双要素登录(SPA 无特征 URL)** | 规则内建（auth.js 规则 6） | URL 无 /login 特征、凭据在 body（`username`+`password` 同现，表单/JSON 双形态） |
| **中段登录链/重登（重开窗口）** | `known/ics_harvest`(条目5 getUserRole)、`opensource/form-flow`(条目3 重登)、`opensource/oauth2-authcode`(条目4 token 刷新) | 登录链在业务请求**之后**（302 跳转链/会话过期重登/token 静默刷新）——auth.js 重开窗口语义（v1.0.57）的真实样本锚，见 `test_regression_samples.js` 4c |

## 动态值形态覆盖矩阵

| 动态值 | 样本来源 | 特征 |
|---|---|---|
| 单号/ID | `known/ktki_detail` `pickingId/objectId/warehouseId` | 长数字/字母混合，跨请求引用（`ics_harvest` 无 `orderNo`——实体对账 0 条，v1.0.62 修表：原表错引） |
| UUID | `opensource/git-apikey` (petstore) | 8-4-4-4-12 形态，create 返回→查询 body 回带，值溯源命中 |
| 时间戳 | `known/ktki_detail` `startTime` (13 位毫秒) | 数字时间戳，同批请求共享（**注**: meta 标注如此, 但 jsonl 实体里 `startTime` 0 条——不可当断言面, 时间戳形态的可断言样本在 `opensource/httpbin-signed`） |
| 签名 | `opensource/httpbin-signed` (sign/nonce/timestamp 三连) | 多字段拼接 + 哈希；sign/nonce 不得误挂链（上游无同值叶） |
| OAuth2 access_token | `opensource/oauth2-authcode` | token 响应产出→下游 body 引用，溯源挂提取链 |
| 表单体动态值 (k=v) | `opensource/form-flow` (k6 html_form_post 形态) | 表单 body 走 URLSearchParams 展开 diff，sessionid 溯源挂提取链 |
| 用户/组织上下文 | `known/ics_harvest` `userId/orgCodes/divisionCode` | 依赖登录响应，同会话复用 |

## 目录约定

```
samples/
├── README.md           本文件（用法/原则）
├── INDEX.md            本文件（覆盖矩阵 + 索引）
├── known/              来源确认的本地录制（回归基线）
│   ├── ics_harvest/    ICS UAT 登录链 + 业务链
│   └── ktki_detail/    KTKI 拣货单详情页 20 接口
└── opensource/         开源项目扒出的真实样本
    ├── apache-jmeter/  官方认证形态测试计划
    ├── form-flow/      表单体 diff 样本 (k6 html_form_post 形态)
    ├── git-apikey/     petstore UUID 动态值样本
    ├── httpbin-signed/ sign/nonce/timestamp 签名形态样本
    ├── k6/             k6 官方认证样本
    ├── oreilly-eventsource/ SSE 端点样本（mime 主信号净化锚）
    ├── oauth2-authcode/ OAuth2 授权码流样本 (RFC 6749 §4.1)
    └── taurus/         Blazemeter/taurus 示例
        ├── blazedemo/  公开站下单流
        ├── csv-login/  CSV 表单登录
        ├── jmx-structure/  控制器/提取器结构
        ├── k6/         k6 单请求
        └── postman/    Postman 集合
```

## 已知形态边界（引擎如实呈现）

- **表单体（x-www-form-urlencoded）v1.0.19 起走同管线**：`diffJsonBodies` 加表单分支（URLSearchParams 展开，path=键名），diff/分类/替换（k=v 精确替换）/值溯源（jsonPathGet 表单取值）与 JSON 全下游一致。**混录边界**：同组 JSON/表单混合时无从对位，跳过不 diff（`opensource/form-flow` 验证；评估后保持——混录只出现在版本迭代期/误录撞 path，按 key 对位 diff 复杂度高收益低）。`applyAiChainToJmx` 与重放 inject 的表单 k=v 替换早已支持（v1.0.18 前就有），此前缺的只是 diff/溯源入口。
- **URL query 参数 v1.0.19 起走同管线**：`analyzeCorrelation` 对组内 query 做 URLSearchParams 展开 diff（path 加 `Q_` 前缀与 body 命名空间区分），timestamp 替换经 `applyDynamicsToQuery` 生效（剥前缀取键）。**保守边界**：`Q_` 动态不挂值溯源链——query 参数的值不在 body 里，corr 合成链只做 body；query 溯源需要 `url.` 形态 toParam，那是 AI 链的能力域。
- **签名类动态值不挂溯源链**：sign/nonce 上游响应里无同值叶，值溯源自然落空（保守正确）。若未来要做"前端签名算法复刻"，属于新能力而非样本缺口。

## 待补充缺口

- [x] **UUID 动态值**样本（`opensource/git-apikey`，v1.0.18）
- [x] **签名动态值**样本（`opensource/httpbin-signed`，v1.0.18）
- [x] **OAuth2 授权码流**样本（`opensource/oauth2-authcode`，v1.0.18）
- [x] **表单体 diff 支持**（`opensource/form-flow` + correlate.js 表单分支，v1.0.19）
- [x] **query 参数 diff 支持**（correlate.js Q_ 前缀管线，v1.0.19）
- [x] **SSE 净化判定样本**（`opensource/oreilly-eventsource` + loader mime 透传，v1.0.65——此前 loader 不读 mime 字段，filterSkippable 的 mime 主路径在样本维度结构性盲区）
- [x] **locust/gatling/scrapy 样本——评估后关闭**：它们是**脚本仓库**不是**请求集合**（`self.client.get()`/Scala DSL），解析出来也只能验证"非 JSON 不炸"（已覆盖）；"跨工具"真正该验证的是导出物能被工具吃（JMX→JMeter 已验证、PY 脚本 py_compile 已验证），那是导出 e2e 不是样本缺口。