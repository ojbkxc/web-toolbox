# MCP 客户端接入指南

> 把 web-toolbox 的抓包 / 导出 / 关联 / 页面操作能力, 接进 Claude Code、Cursor、Trae 等
> 任意支持 MCP 的 AI 客户端。

## 一分钟版

```bash
# 1. 装依赖(仅 bridge 这层; 扩展本体零依赖)
cd D:/GitHub/web-toolbox/bridge
npm install

# 2. 起常驻 daemon(扩展要连它; 控制类工具需 --allow-control)
node src/index.js --daemon --allow-control
# 首次会打印令牌, 或查看: type %USERPROFILE%\.web-toolbox\bridge-token

# 3. 浏览器装扩展(chrome://extensions 开发者模式加载仓库根目录)

# 4. 扩展选项页「AI 桥接」填地址 ws://127.0.0.1:9280/ext + 令牌, 点「立即连接」

# 5. 连不上先跑自检
node bridge/src/doctor.js
```

## 客户端配置

### Claude Code

```bash
claude mcp add web-toolbox -s user -- node D:/GitHub/web-toolbox/bridge/src/index.js --allow-control
```

或写进 `~/.claude.json` 的 `mcpServers`:

```json
{
  "mcpServers": {
    "web-toolbox": {
      "command": "node",
      "args": ["D:/GitHub/web-toolbox/bridge/src/index.js", "--allow-control"]
    }
  }
}
```

### Cursor / Trae / 其它 MCP 客户端

```json
{
  "mcpServers": {
    "web-toolbox": {
      "command": "node",
      "args": ["D:/GitHub/web-toolbox/bridge/src/index.js", "--allow-control"]
    }
  }
}
```

## 连接拓扑

```
AI 客户端 ──MCP stdio──> bridge(本进程) ──WebSocket──> daemon(常驻) <──拨出── Chrome 扩展
```

- **daemon 必须常驻**: 扩展只能拨出(浏览器扩展不能监听端口), AI 客户端是"用时才起"的;
  MCP 进程检测不到 daemon 会自动在后台拉起一个, 并透传 `--allow-control` 等参数。
- 两个进程都起 WS 时只有先到者占端口, 后者自动转代理模式。
- `--allow-control` 是**两个独立开关**(MCP 进程与 daemon 各自一份):
  只给客户端加而 daemon 没加时, 控制类调用会在 daemon 侧被拒 —— `bridge_status` 的
  `controlMismatch` 字段会明说该重启谁(详见 [bridge/README.md](../bridge/README.md))。

## 工具分层

| 层 | 工具 | 需要 `--allow-control` |
|---|---|---|
| 状态/抓包 | `bridge_status` `net_list` `net_get` `net_hosts` `tab_list` | |
| 导出/关联 | `export_har` `export_jmx` `export_python` `correlate` | |
| 控制台 | `console_read` | |
| 录制 | `rec_start` `rec_stop` | ✓ |
| 页面操作 | `page_snapshot` `page_click` `page_type` `page_press` `page_hover` `page_select` `page_scroll` `page_wait` `page_eval` `page_screenshot` | ✓ |
| 标签页 | `tab_navigate` `tab_activate` `tab_close` | ✓ |
| 回归 | `chain_replay` | ✓ |
| 控制台 | `console_clear` | ✓ |

完整清单(含参数、结构化返回标记)见 [bridge/README.md](../bridge/README.md#工具一览)。

**工具注解**: 每个工具带 `readOnlyHint` / `destructiveHint` —— 客户端可对只读工具免确认、
对破坏性工具(点击/输入/执行 JS/重放)要求二次确认。7 个工具额外提供 `structuredContent`
机读输出(免 JSON.parse 文本)。

## 归档: 只写不读(有意为之)

`--archive-dir` 会把扩展推来的条目按天追加到本地 JSONL(`harvest-YYYY-MM-DD.jsonl`),
但 **MCP 工具面不提供归档查询** —— `bridge_status` 的 `archive` 字段只报"有没有/写了多少"。

为什么不做查询工具: 归档里是**明文流量**, 加一个查询工具等于把 AI 的读取面扩到历史全量数据。
现在的出口是用户自己看文件(每行 `{batchId, archivedAt, entry}`), 需要时直接 `type`/`jq`。
归档不会被自动清理(`--archive-keep-days 0` 默认永不删); 要限制体积请显式设保留天数。

## 常见问题

**Q: 为什么连不上?**
按顺序查:
1. `node bridge/src/doctor.js` —— 逐条 PASS/FAIL(有 daemon 时 18 项), 每条带"下一步";
2. 常见根因: daemon 没起 / 令牌不匹配 / 扩展没点「立即连接」/ 协议版本不一致。

**Q: 控制类工具被 forbidden?**
看 `bridge_status` 的 `controlMismatch` —— 本地与 daemon 的 `--allow-control` 有一个没开。
哪个没开重启哪个。

**Q: 导出工具报"产物过大"?**
用过滤参数缩小(`hostIncludes` / `pathIncludes` / `statusMin=400` 只看失败), 或调大 `maxChars`
(错误消息里会给建议值)。脚本类产物截断即废, 所以不返回半截。

**Q: 抓不到某域名的请求?**
`net_hosts` 看域名分布; 若目标域没出现, 检查扩展选项页的域名授权清单
(`optional_host_permissions` 模型: 不配域名对任何站点无权工作)。

## 验证

```bash
node bridge/smoke.mjs            # 端到端(鉴权/请求/事件/注解/错误语义/结构化/体积守卫/工具全覆盖)
node bridge/src/doctor.js        # 自检(有 daemon 时 18 项)
node bridge/test-doctor.mjs      # doctor 端到端(真起 daemon 四场景)
cd bridge && npm test            # 聚合: unit(71) → exporters(46) → doctor(21) → smoke(74)
```