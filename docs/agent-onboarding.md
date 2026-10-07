# Agent 接入手册

这份文档记录**每个 Agent 到底是怎么被驱动的**：入口命令、认证方式、输出形态、会话续跑能力、以及踩到的坑。新增适配器时照这个格式补一节。

所有结论都来自本机实测（2026-10-07），不是照文档抄的。

## 总览

| Agent | 入口 | 输出形态 | 会话续跑 | 状态 |
| --- | --- | --- | --- | --- |
| DeepSeek Harness | `dsh --profile headless --json` | NDJSON（行分隔） | ✅ `--session-id` | 已接入 |
| Codex | `codex exec --json` | JSONL（行分隔） | ✅ `exec resume <thread_id>` | 已接入 |
| MiniMax | `mmx text chat --messages-file -` | **多行 pretty JSON（整体）** | ❌ 由中台补历史 | 已接入 |
| Kimi | `kimi-daimon --prompt` | **日志 + 回答混在 stdout** | ❌ 由中台补历史 | 已接入 |
| ZCode | `zcode.cjs -p ... --json` | 待定 | ✅ `--resume <sess_...>` | **卡在 CLI 登录态** |

适配器契约见 [adapter-contract.md](adapter-contract.md)。三处通用能力是这次为异构 Agent 加的：

- `parseLine`（行分隔流式）**或** `parseOutput`（整体输出）；
- `promptChannel`：`stdin` / `stdin-json` / `argv`；
- `env()`：适配器自带环境变量；
- `capabilities.resume === false` 时，中台自动注入一段有上限的历史（`buildHistoryPrompt`）。

## 1. DeepSeek Harness

```bash
dsh --profile headless --json --session-id <id> -
```

- 可执行文件在 App 包内：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（`dsh` 不在 PATH 上，适配器按候选路径探测）。
- `--json` 输出 NDJSON：`session` / `thinking` / `text` / `status` / `final`。
- 任务从 stdin 读（`-`）。
- 会话续跑：`--session-id session-xxxx`，未知 id 会报错。

## 2. Codex

```bash
codex exec --json --skip-git-repo-check --sandbox read-only -C <dir> -
codex exec resume --json --skip-git-repo-check <thread_id> -
```

- 需要 ChatGPT 登录态（`codex login status`）。
- **两个子命令的参数签名不同**：`resume` 不接受 `--sandbox` / `-C`，且选项必须排在会话 id 之前。
- 不在 git 仓库里必须带 `--skip-git-repo-check`，否则拒跑。
- stdin 必须显式关闭，否则会等待输入挂住。
- 条目级 error（如 `Under-development features enabled: chronicle`）只是警告，适配器标为 `fatal: false`。

## 3. MiniMax

```bash
echo '[{"role":"user","content":"..."}]' | mmx text chat --messages-file - --output json --non-interactive
```

- 用全局 `mmx` CLI（`~/.nvm/.../bin/mmx`），OAuth 登录态；`mmx quota show` 可查额度。
- **`--messages-file -` 需要裸数组**（`[{...}]`）。传 `{"messages":[...]}` 会报 `Error: s is not iterable`。
- 输出是**一个跨多行的 JSON 对象**，所以要按整体解析而不是按行。
- 响应里取 `content[].type === 'text'` 拼接；`base_resp.status_code !== 0` 视为业务错误。
- 没有会话续跑 → 中台注入历史。

## 4. Kimi

```bash
DAIMON_CONFIG_PATH="$HOME/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json" \
"/Applications/Kimi.app/Contents/Resources/resources/daimon-bundle/bin/kimi-daimon" \
  --node "$(command -v node)" --prompt "<正文>"
```

- **引擎不是 `Kimi Code.app`**：`Kimi Code.app`（`com.kimi.code.desktop`）只是渲染层、没有 CLI；真正的 runner 在 `Kimi.app` 内置的 daimon（`@kimi/daimon`）里。
- 启动器是 sh 包装脚本，需要 `--node` 显式指定 Node。
- `~/.kimi` 在本机不存在，必须用 `DAIMON_CONFIG_PATH` 指向**桌面版共享配置**，否则报 adapter config missing。
- **正文必须走 `--prompt`（argv）**：stdin 是它的控制命令通道（`health` / `stop` / `cancel` / `help`），塞正文会被当成命令。
- **日志与回答都在 stdout**，要按 `^<ISO 时间戳> LEVEL ` 前缀过滤日志；回答是夹在日志之间的裸文本。
- 有 `--continue` / `--session <conversation-key>`，但输出里拿不到稳定的会话键，所以声明不支持续跑、由中台补历史。
- 它持有 `runner.lock`：**同一时刻只能跑一轮**——中台为此加了按 Agent 串行队列。

## 5. ZCode（尚未接入）

入口本身是通的：

```bash
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json" \
node "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" -p "<正文>" --json --mode plan
```

**卡点**：CLI 找不到可用的登录态，报 `Error: Model creation failed (traceId: ...)`。

排查记录（每一步都是实测）：

| 现象 | 结论 |
| --- | --- |
| 默认运行报 `无法定位 CLI ZCode Built-in Provider Config` | CLI 从自身目录找 provider 配置，App 里它在 `Resources/config/provider/` |
| 设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 后 | 配置定位成功，但变成 `Model creation failed` |
| `ZCODE_DATA_BASE_DIR=~/.zcode/v2` | 仍失败；`~/.zcode/v2/config.json` 只有 `provider` 一个键 |
| 端口 61923（`zcode-host-local-1`） | 试了 `/`、`/health`、`/api`、`/v1/models`、`/mcp`、`/status` 全部 404，不是可猜的 REST API |
| `zcode.cjs app-server`（stdio JSON-RPC） | 报 provider 配置错误，协议未知 |

补充排查（2026-10-07 复查）：

| 又试了什么 | 结果 |
| --- | --- |
| `ZCODE_DATA_BASE_DIR=~/.zcode` | 仍 `Model creation failed` |
| `ZCODE_DATA_BASE_DIR=~/.zcode/v2`（GUI 凭据所在处） | 仍失败 |
| `ZCODE_DATA_BASE_DIR=~/.zcode/cli` | 仍失败 |
| 核对 `~/.zcode/v2/credentials.json` 是否存在 | 存在（GUI 用的），但 CLI 不认它 |

**结论**：这不是路径问题，是 **CLI 侧没有可用登录态**——GUI 登录 ≠ CLI 登录。
能试的都试过了，剩下的只能由使用者本人完成一次 OAuth，不适合代跑。

**待办**：需要有人先在 CLI 侧完成一次登录

```bash
node "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" login
```

登录成功后适配器可以直接照搬 MiniMax 的整体输出模式（它有 `--json` 与 `--resume <sess_...>`，一旦通就是四个里能力最全的之一）。**不建议**再花时间爆破私有端口。

## 侦察纪律（写下来避免下次重复踩）

- 只用只读手段：`lsof`、`ps -o command`、`ls`、`curl -s -m 3`、`strings`/`grep -a`、`--help`/`--version`/`doctor`。
- 不对未知端口做路径爆破（每个端口最多试 5 个常见路径，全 404 就停）。
- 不安装任何东西、不发起真实模型请求、不写文件。
- 报告里不出现凭据：token / apiKey / device id 一律 `<redacted>`。
