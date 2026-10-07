# 适配器契约 v1

中台与任何 Agent 之间只有这一份契约。新增 Agent = 新增一个适配器文件，不改核心。

## 统一事件模型

所有适配器把各自的原生输出归一成下面这些类型（`{ type, ... }`）：

| type | 含义 | 关键字段 |
| --- | --- | --- |
| `session.started` | 会话开始/续跑 | `sessionId` |
| `thinking` | 思考过程（可无） | `text` |
| `text` | 正文增量或整段 | `text` |
| `status` | 阶段变化 | `phase` |
| `usage` | 用量 | `usage` |
| `error` | 错误 | `message` |
| `final` | 本轮最终文本 | `text` |
| `turn.end` | 本轮结束 | `reason` |

未知的原生事件类型**不丢弃**，归一为 `{ type: 'raw', raw }`，便于版本变化时排错。

## 适配器接口

```js
export const adapter = {
  id: 'dsh',                       // 稳定标识
  label: 'DeepSeek Harness',       // 展示名
  capabilities: { resume: true, streaming: true, tools: true },
  buildArgs({ sessionId, cwd }),   // → string[]，命令参数
  parseLine(line),                 // → NormalizedEvent[]（一行原生输出可能产出多个事件）
  command(),                       // → 可执行文件路径
};
```

## 执行器约定（核心必须做的事）

1. **prompt 走 stdin**，不走 argv（避免参数长度限制与转义问题）；
2. **显式关闭 stdin**（`-` + `end()`），否则 Codex 会等待输入挂住；
3. **不以退出码判成败**：实测两个 CLI 失败时退出码都可能是 0；
4. 判定失败的条件：出现 `error` 事件，或整轮没有产出任何文本，或 stderr 有内容且无文本；
5. **超时**默认 180s，到点 `SIGTERM`（5s 宽限）→ `SIGKILL`；
6. 每轮返回：`{ ok, sessionId, text, usage, error, events }`。

## 已实测的原生格式参考

### DeepSeek Harness（`dsh --profile headless --json`，NDJSON）

```json
{"type":"session","sessionId":"session-16759da8-02d4-42a8-94a1-2522cdc82c81","cwd":"..."}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":""}
{"type":"text","text":"OK"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":8553,"outputTokens":2,"totalTokens":8555}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"OK"}
```

续跑：`--session-id <id>`（未知 id 会报错）。

### Codex（`codex exec --json`，JSONL）

```json
{"type":"thread.started","thread_id":"01a1168a-78a9-76c1-be03-0b0d3b31fb48"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":23456,"cached_input_tokens":13184,"output_tokens":5}}
```

续跑：`codex exec resume <thread_id>`。

### 实测踩到的三个坑

1. Codex 不在 git 仓库内会拒绝执行（`Not inside a trusted directory`），必须 `--skip-git-repo-check` 或在仓库内运行；
2. Codex 在有 stdin 的情况下会追加读取，后台调用必须显式送 `-` 并关闭；
3. **失败时退出码仍为 0**——所以适配器必须解析内容。
