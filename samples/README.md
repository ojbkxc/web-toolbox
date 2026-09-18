# samples — 通用引擎验证样本库

本目录存放**通用脚本引擎**（登录链识别 / 动态值关联 / 平台口径导出）的验证样本。
设计原则：**通用性必须用开源/多样样本证明，不能只拿自造 KTKI/ICS 样本**（自造样本只能证明"规则对自己有效"）。

## 目录约定

```
samples/
├── README.md                本文件
├── INDEX.md                 覆盖矩阵 + 样本索引
├── loader.js                样本加载器(统一成 {meta, entries} 供回归/引擎消费)
├── test_regression_samples.js  样本库回归骨架(独立于主回归, 用开源样本验证引擎通用性)
├── known/                   来源确认的本地录制（回归基线，非通用性证据）
│   ├── ics_harvest/         ICS UAT 登录链 + 业务链
│   └── ktki_detail/         KTKI 拣货单详情页 20 接口
└── opensource/              开源项目扒出的真实样本（通用性证据，必须标注出处）
    ├── apache-jmeter/       apache/jmeter 官方认证形态测试计划
    ├── form-flow/           表单体 diff 样本(k6 html_form_post 形态, v1.0.19)
    ├── git-apikey/          petstore UUID 动态值样本(v1.0.18)
    ├── httpbin-signed/      sign/nonce/timestamp 签名形态样本(v1.0.18)
    ├── k6/                  grafana/k6 官方认证样本
    ├── oauth2-authcode/      OAuth2 授权码流样本(RFC 6749 §4.1, v1.0.18)
    ├── oreilly-eventsource/ SSE 端点样本(mime 主信号净化锚, v1.0.65)
    └── taurus/              Blazemeter/taurus 示例
        ├── blazedemo/       公开站下单流(验证登录识别不误报)
        ├── csv-login/       CSV 表单登录
        ├── jmx-structure/   控制器/提取器结构(平台口径参照)
        ├── k6/              k6 单请求
        └── postman/         Postman 集合
```

## 样本元数据格式

每个样本子目录必须带 `sample.json`，字段：

```jsonc
{
  "source": "apache/jmeter 仓库 test/",
  "url": "https://github.com/apache/jmeter/tree/.../test",
  "auth_form": "CAS | SSO | token_header | cookie | basic | oauth2 | none",
  "dynamic_values": ["order_no", "uuid", "timestamp", "sign", "seq"],
  "entries": 12,
  "note": "该样本覆盖的登录/动态值形态"
}
```

`auth_form` 和 `dynamic_values` 是规则校准的关键索引。jsonl 行内可选字段：`response`（响应体，认证形态识别用）、`status`、`mime`（响应 mime——引擎真实条目必有，SSE 等净化判定的主信号，v1.0.65 起 loader 透传）。

## 当前样本清单

| 目录 | 来源 | 认证形态 | 动态值 | 状态 |
|---|---|---|---|---|
| `known/ics_harvest` | iserver/.ics_harvest.jsonl 本地录制 (ICS UAT) | cookie+token | orgCodes/userId/divisionCode/typeCode/orgCode | ✅ 已迁移 |
| `known/ktki_detail` | 拣货单查询接口 YAML (KTKI UAT) | cookie+CAS | pickingId/pickingOrderNo/objectId/warehouseId/divisionCode/startTime/orgCode | ✅ 已迁移 |
| `opensource/apache-jmeter` | apache/jmeter 官方 bin/testfiles | basic/digest/cookie | login/password | ✅ 已扒 |
| `opensource/k6` | grafana/k6 官方 examples | basic/digest/cookie/jwt | user/passwd/token | ✅ 已扒 |
| `opensource/taurus/blazedemo` | Blazemeter/taurus existing-BlazeDemo.jmx | none(公开站) | — | ✅ 已扒 |
| `opensource/taurus/csv-login` | Blazemeter/taurus csv-usage.yml | form | username/password/page | ✅ 已扒 |
| `opensource/taurus/jmx-structure` | Blazemeter/taurus tests jmx | none(结构) | — | ✅ 已扒 |
| `opensource/taurus/k6` | Blazemeter/taurus k6_example.js | none | — | ✅ 已扒 |
| `opensource/taurus/postman` | Blazemeter/taurus postman 集合 | none | — | ✅ 已扒 |
| `opensource/git-apikey` | OpenAPI petstore + REST 惯例 | token(api-key) | uuid/petId | ✅ v1.0.18 |
| `opensource/httpbin-signed` | wechatpay 等签名头惯例 | token+sign | sign/nonce/timestamp/orderNo | ✅ v1.0.18 |
| `opensource/oauth2-authcode` | RFC 6749 §4.1 授权码流 | OAuth2 code | access_token/code | ✅ v1.0.18 |
| `opensource/form-flow` | k6 html_form_post 形态 | form | sessionid | ✅ v1.0.19 |
| `opensource/oreilly-eventsource` | O'Reilly SSE Blueprint 真实端点形态 | none | — | ✅ v1.0.65 |

引擎能力边界与缺口收口状态见 [INDEX.md](INDEX.md) 的「已知形态边界」「待补充缺口」两节。

## 验证入口

样本库回归（通用性证据，开源样本驱动）：

```
node samples/test_regression_samples.js
```

断言内容：
1. 每个样本能被 `analyzeCorrelation`/`buildJmx` 消化（不炸，XML 合法）
2. 认证形态特征与 `sample.json` 元数据一致（known 样本反向校验元数据真实性）
3. 公开站样本（blazedemo）**不得误报** cookie/token/basic 等认证形态
4. 检测到的动态值形态必须在 `meta.dynamic_values` 有标注（防止元数据造假）
5. 形态样本必须有引擎确定产出（4b 节：UUID/签名/OAuth2/表单各样本的动态分类、溯源链命中、不误报逐一断言——样本只"不炸"是摆设）
6. `sample.json` 的 `entries` 必须等于 loader 实际加载条数（1b 对账断言，防元数据漂移——entries 口径 = loader 加载条数，不是"文件数"也不是"结构特征数"）
7. SSE 净化判定锚（4e 节, v1.0.65）：`oreilly-eventsource` 的 SSE 条仅被 mime 主信号命中（请求头表无响应 Content-Type）、同批 API JSON 业务条不误杀、存量样本零污染扫描——filterSkippable 双形态判定（响应 mime + headers 兜底）的真实样本回归面

跑全部模块单测（含主回归）：

```
node test_regression.js
```