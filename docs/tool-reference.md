# 工具参考(Tool Reference)

> 本文件由 `node bridge/gen-tool-reference.js > docs/tool-reference.md` **生成**, 不要手改。
> 源头是 `bridge/src/tools.js`(name/title/描述/参数/注解), 漂移会在 `check_doc_counts` 闸门红。

## 状态与抓包(只读)

### `bridge_status`

桥接状态 — 检查 Chrome 扩展是否已连接到 bridge, 返回扩展版本、录制状态与能力开关。任何操作前先调这个。

> 只读 · 结构化返回

### `net_list`

列出抓到的请求 — 列出扩展当前抓到的请求(按请求时间序)。只返回摘要, 不含响应正文; 需要正文用 net_get。

| 参数 | 类型 | 说明 |
|---|---|---|
| ...filterShape | | 通用过滤(见 net_list 的过滤参数) |
| `limit?` | number | 最多返回条数, 默认 50, 上限 500 |
| `offset?` | number | 跳过前 N 条(分页) |

> 只读 · 结构化返回

### `net_get`

获取请求详情 — 按 id 获取一条请求的完整内容(请求头、请求体、响应头、响应正文)。正文超长会截断并标注。

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string | net_list 返回的条目 id |
| `maxBody?` | number | 响应正文最多返回字符数(不是字节), 默认 20000 |

> 只读 · 结构化返回

### `net_hosts`

抓包域名分布 — 统计当前抓包覆盖的域名与条数, 用于判断录制配置是否漏了网关域(常见漏录原因)。

> 只读 · 结构化返回

### `tab_list`

列出标签页 — 列出当前 Chrome 的标签页(id/标题/URL/是否活动)。

> 只读 · 结构化返回

## 导出与关联(只读)

### `export_har`

导出 HAR — 把当前抓包导出为 HAR 1.2(浏览器/Postman/DevTools 通用)。返回 JSON 文本。

> 只读

### `export_jmx`

导出 JMeter 脚本 — 把当前抓包导出为 JMeter .jmx 脚本(自动挂断言/登录前置/动态值关联, 与扩展侧导出同源)。

| 参数 | 类型 | 说明 |
|---|---|---|
| ...filterShape | | 通用过滤(见 net_list 的过滤参数) |
| `threads?` | number | 线程数, 默认 1(巡检安全口径) |
| `maxChars?` | number | 产物字符上限, 默认 2000000; 超限报错而非截断 |

> 只读

### `export_python`

导出 Python 重放脚本 — 把当前抓包导出为 requests 重放脚本(含参数链内联)。产物过大时明确报错(不返回半截脚本)。

> 只读

### `correlate`

自动关联动态值 — 对当前抓包做参数关联分析(同一接口多次录制的动态值 diff), 返回可参数化的字段列表。

| 参数 | 类型 | 说明 |
|---|---|---|
| `pathIncludes?` | string | 只看路径包含这段的接口, 如 /order |

> 只读 · 结构化返回

## 控制台

### `console_read`

读取控制台日志 — 读取录制期间页面产生的 console.* 输出与未捕获异常(环形缓冲, 最多 500 条, 

| 参数 | 类型 | 说明 |
|---|---|---|
| `level?` | string | 只看某个级别: error / warn / log / info / debug |
| `limit?` | number | 最多返回条数, 默认 200, 上限 500 |

> 只读

### `console_clear`

清空控制台日志 — 清空扩展侧的控制台日志缓冲(不影响已录制的请求数据)。

> 破坏性 · 需 `--allow-control`

## 录制控制

### `rec_start`

开始录制 — 在指定标签页开始抓包(需要管理权限: --allow-control)。不传 tabId 则用当前活动标签页。

| 参数 | 类型 | 说明 |
|---|---|---|
| `tabId?` | number | 目标标签页 id, 省略则用活动标签页 |

> 需 `--allow-control`

### `rec_stop`

停止录制 — 停止抓包并 detach 调试器。数据保留。

> 需 `--allow-control`

## 标签页

### `tab_navigate`

打开网址 — 让指定标签页(省略则活动页)导航到 url, 并等待加载完成。

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 完整 URL |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 需 `--allow-control`

### `tab_activate`

切换标签页 — 把指定标签页切到前台并聚焦窗口。截图前通常需要先激活。

| 参数 | 类型 | 说明 |
|---|---|---|
| `tabId?` | number | 省略则用当前活动页 |

> 需 `--allow-control`

### `tab_close`

关闭标签页 — 关闭指定标签页。

| 参数 | 类型 | 说明 |
|---|---|---|
| `tabId?` | number | 要关闭的标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

## 页面操作

### `page_snapshot`

读取页面结构 — 返回当前页面的可访问性快照, 每个可交互元素带 ref 编号。

| 参数 | 类型 | 说明 |
|---|---|---|
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |
| `maxChars?` | number | 快照最多返回字符数, 默认 20000 |

> 只读 · 需 `--allow-control`

### `page_click`

点击元素 — 按 page_snapshot 返回的 ref 点击元素(真实鼠标事件, 非合成 click)。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ref` | string | page_snapshot 里的 ref, 如 e12 |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

### `page_type`

输入文本 — 按 ref 定位输入框, 先聚焦清空再写入。默认用 insertText 整串写入(触发真实的 input 事件, 

| 参数 | 类型 | 说明 |
|---|---|---|
| `ref` | string | page_snapshot 里的 ref, 如 e12 |
| `text` | string | 要输入的文本(非 ASCII 也按文本插入) |
| `submit?` | boolean | 输入后是否回车提交 |
| `keyByKey?` | boolean | 逐字符派发真实按键(默认 false 走 insertText 整串写入) |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

### `page_press`

按键 — 在焦点元素上按键。支持 Enter / Tab / Escape / Backspace / Delete / Space / 

| 参数 | 类型 | 说明 |
|---|---|---|
| `key` | string | 键名, 如 Enter / Tab / a |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

### `page_hover`

悬停元素 — 鼠标悬停在 ref 元素上。菜单常见: 必须悬停才展开二级菜单。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ref` | string | page_snapshot 里的 ref |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 需 `--allow-control`

### `page_select`

下拉框选择 — 在原生 <select> 上按 value 或显示文本选择。自定义下拉请用 page_click 展开后点选项。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ref` | string | page_snapshot 里的 ref |
| `value` | string | 选项的 value 或显示文本 |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

### `page_scroll`

滚动页面 — 滚动到指定 ref 元素, 或按像素滚动, 或滚到底部。懒加载列表需要滚动才能触发后续请求。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ref?` | string | 滚到该元素(优先于 delta) |
| `deltaY?` | number | 向下滚动像素, 负数向上 |
| `deltaX?` | number | 横向滚动像素, 正数向右 |
| `toBottom?` | boolean | 滚到页面底部 |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 需 `--allow-control`

### `page_wait`

等待条件 — 等待元素出现/消失、文本出现、URL 包含某串, 或固定毫秒。比固定 sleep 可靠, 

| 参数 | 类型 | 说明 |
|---|---|---|
| `selector?` | string | CSS 选择器, 等它出现 |
| `text?` | string | 等页面出现这段文字 |
| `urlIncludes?` | string | 等 URL 包含这段 |
| `untilGone?` | boolean | 反转为'等到消失' |
| `ms?` | number | 固定等待毫秒(无其他条件时使用) |
| `timeoutMs?` | number | 超时, 默认 10000 |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 只读 · 需 `--allow-control`

### `page_screenshot`

截图 — 截取当前可视区域, 返回 base64 PNG。

| 参数 | 类型 | 说明 |
|---|---|---|
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 只读 · 需 `--allow-control`

### `page_eval`

在页面执行 JS — 在页面上下文执行一段 JS 表达式并返回结果(MAIN world, 可访问页面自己的变量)。

| 参数 | 类型 | 说明 |
|---|---|---|
| `script` | string | JS 表达式, 如 document.title |
| `allFrames?` | boolean | 在所有 iframe 里都执行, 返回每个 frame 的结果 |
| `tabId?` | number | 目标标签页 id, 省略用活动标签页 |

> 破坏性 · 需 `--allow-control`

## 回归

### `chain_replay`

链路重放(回归 diff) — 按录制顺序重放当前抓包, 每条响应与录制快照自动 diff(时间戳/长 token 归一化)。

| 参数 | 类型 | 说明 |
|---|---|---|
| ...filterShape | | 通用过滤(见 net_list 的过滤参数) |
| `ids?` | array | 只重放指定条目 id; 省略则重放全部(遵守过滤词) |
| `timeoutMs?` | number | 单条超时毫秒, 默认 30000 |
| `tabId?` | number | 在哪个标签页重放, 省略用活动页 |

> 破坏性 · 需 `--allow-control` · 结构化返回


