# 排障指南

> 按"症状 → 第一步查什么 → 根因 → 修法"组织。先跑 [`node bridge/src/doctor.js`](#doctor-自检)
> 能省一半时间。

## doctor 自检

```bash
node bridge/src/doctor.js
```

逐条 PASS/FAIL(有 daemon 时 18 项) + INFO(归档保留期/体积/余量), 每条 FAIL 带具体"下一步":
令牌活体握手(用 daemon 自己的令牌验你手里这串)、daemon 端口、协议与包版本一致性、
监听地址暴露面(非回环时令牌是唯一防线)、归档目录可写、扩展 manifest 完整性等。
**连不上时第一个跑它**, 不要先猜。

## 症状: MCP 客户端看不到扩展数据

**第一步**: `bridge_status` 看 `connected`。

| connected | 含义 | 下一步 |
|---|---|---|
| `false` + 提示连接指引 | 扩展没连 daemon | Chrome 打开扩展选项页 → 「AI 桥接」→ 填 `ws://127.0.0.1:9280/ext` + 令牌 → 点「立即连接」 |
| `true` 但数据为空 | 真没抓到 | 看 `net_hosts` 域名分布, 再查域名授权 |

**根因高频**: 令牌轮换过 —— doctor 的「令牌被 daemon 接受」会精确红这一项。

## 症状: 控制类工具全部 forbidden

`bridge_status` 的 `controlMismatch`:

- `daemon 未启用控制类工具` → 用 `--allow-control` **重启 daemon**;
- `本地未传 --allow-control` → 给 **MCP 进程**加参数。

两个是独立开关, 只开一个就 forbidden — 这是设计(闸门在 daemon, 真正的信任边界只有一道)。

## 症状: 录制中但什么都没录到

1. **域名授权**: 扩展录音只录已授权域名(引擎唯一过滤就是域名授权)。`net_hosts` 看有没有目标域;
   侧栏顶部有 `⚠ N 个域被过滤` 提示(来自 `unmatchedHosts`), 按提示把网关域也配上。
2. **黄条被取消**: Chrome 顶部「正在调试此浏览器」黄条被点掉 = `chrome.debugger` 断开,
   录制静默失效。侧栏诊断日志有对应 warn(`getDiagLog` 导出)。
3. **暂停状态**: popup 显示 PAUSE 而非 REC —— 暂停期间新请求不入列(在途照常落库)。

## 症状: AI 点了页面但录制断了

桥接控制页面时会临时 attach/detach 调试器, 这**不是**录制中断 —— 双方都有守卫:
桥接侧只 detach 自己 attach 的(v1.1.35), 引擎侧跳过带 `toolboxBridgeOwnDetach` 标记的
detach 事件(v1.1.36)。若真断了, 先确认不是外部工具(第二个 CDP 客户端)抡走了调试器。

## 症状: 导出报「产物过大」

实测 3000 条会产 JMX ≈6.7MB / HAR ≈5.3MB, 超 `maxChars`(默认 2M)就明确失败 ——
**不返回半截脚本**(半截 JSON 不是 HAR)。错误消息里带三条路:
按域名 `hostIncludes`(列出真实域名)/ 按前缀 `pathIncludes` / `statusMin=400` 只看失败;
确实要全量就按建议值调大 `maxChars`。

## 症状: 重放结果与录制不一致

先看 verdict 分类再定位:
- **FAIL**(状态码变) → 服务端行为变了或认证失效;
- **DIFF**(响应体差异) → `normalizeForCompare` 已归一时间戳/长 token, 剩下的差异大概率是业务数据;
- **ERR**(网络错误) → 从页面上下文发(跨域/Cookie 缺失)。

认证失效(响应含会话过期标记)时先做 Cookie 桥: 选项页导出 `cookies_*.state.json`,
`page.wait` 等页面稳定后再重放。

## 症状: bridge 退出码 2

参数错。一行提示不含栈: 未知参数或值非法(如 `--port http`)。支持 `--flag=value` 形态,
值里可含 `=`(令牌常见)。

## 验证命令

| 层 | 命令 | 覆盖 |
|---|---|---|
| 扩展回归 | `node test/run_all.js` | 全量(引擎/UI/导出/AI 卫生/桥接三层) |
| 桥接聚合 | `cd bridge && npm test` | unit 71 → exporters 46 → doctor 21 → smoke 74 |
| 排障 | `node bridge/src/doctor.js` | 自检(有 daemon 时 18 项) + 归档 INFO |