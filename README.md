# RelayDeck 接力台

多 Agent 中台 + EasyInput 硬件控制面。**8 键 + 1 旋钮**完成切人、接力、定位、复制、拉群——手不离键盘。

> 第 8 课毕业大作业项目。设计取舍见 [charter.md](charter.md)，推进计划见 [plan.md](plan.md)，适配器契约见 [docs/adapter-contract.md](docs/adapter-contract.md)，四个 Agent 的接法见 [docs/agent-onboarding.md](docs/agent-onboarding.md)，实板接入清单见 [docs/hardware-stage2b.md](docs/hardware-stage2b.md)。
>
> **提交用交付包**：[作业正文](交付/1-作业正文.md) · [证据清单](交付/2-证据清单.md) · [复现手册](交付/3-复现手册.md) · [提交前自检单](交付/4-提交前自检.md)
>
> 另有一份**自包含**的网页版（截图内联、无死链，适合直接发布）：[交付/5-作业正文-网页版.html](交付/5-作业正文-网页版.html)（由 `node scripts/build-publish-html.mjs` 生成）
>
> 唯一未完成的硬指标：**作品的可公开访问链接**（把作业正文上传成飞书文档后，把链接填回作业正文开头）。

## 当前状态

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 接入 DeepSeek Harness | ✅ 真实跑通 | `dsh --profile headless --json`（NDJSON，可续跑） |
| 接入 Codex | ✅ 真实跑通 | `codex exec --json`（JSONL，可 `resume`） |
| 接入 MiniMax | ✅ 真实跑通 | `mmx text chat`（整体 JSON，无续跑 → 中台补历史） |
| 接入 Kimi | ✅ 真实跑通 | `kimi-daimon --prompt`（日志与回答混在 stdout，需过滤） |
| ZCode | ⏳ 卡在 CLI 登录态 | 入口与报错全过程记录在 [agent-onboarding.md](docs/agent-onboarding.md) |
| 归一化事件模型 | ✅ | 行分隔流式 **和** 整体输出两种模式 |
| 中台 HTTP + SSE | ✅ | `/api/state`、`/api/ask`、`/api/roundtable`、`/api/hardware` |
| 会话隔离 | ✅ | 续跑 session 按「会话 × Agent」隔离，换话题不串上下文 |
| 全文搜索与跳转 | ✅ | `/api/search`，`/` 聚焦、`Enter` 跳到下一个命中 |
| 接力链回溯 | ✅ | 消息上渲染面包屑，可点击回到链上任一环 |
| 用量可见 | ✅ | 每 Agent 的轮数 / token / 平均耗时（四家 usage 字段不同，已折算） |
| **接力链导出 Markdown** | ✅ | `GET /api/export?message=`，界面上有「导出接力链」按钮 |
| **会话软归档与恢复** | ✅ | `PATCH /api/conversations {id, archived}`；不删数据，列表里可一键恢复 |
| 圆桌广播 + 主持人汇总 | ✅ | [4 个异构 Agent 的原始事件流](evidence/roundtable-4agents-20261007T215742.sse) |
| 硬件命令层 + LED 真值表 | ✅ 纯逻辑已测 | `src/hardware/`，S1–S8 / 旋钮 → 中台命令；5 颗 WS2812 状态编码 |
| **板载 LED 协议对接** | ✅ 端到端已验 | **复用固件已有的 Agent Status v1**（report `0x12`）：聚合帧 + 编码器 + [13/13 验收](evidence/)，见 [阶段2b 清单](docs/hardware-stage2b.md) |
| 全局热键守护进程 | ✅ 已编译 | `tools/hotkeyd.swift`（Swift，CGEventTap），`--selftest` 实测通 |
| 硬件模拟器 | ✅ | `bin/simulate.mjs`，没板子也能驱动整条链路 |
| **实板 HID 工具** | ⏸ 暂停使用 | `tools/hidtool.swift` 已实测过一次（设备身份、Feature 写通路）；**板子正被另一门课占用，按要求不再对设备做任何操作** |
| **中台 → 实板 桥** | ⏸ 默认关闭不启用 | `src/hardware/bridge.mjs` 已实现且有单测；**默认关闭**，只有显式设 `RELAYDECK_HID_BRIDGE=1` 才会写设备 |
| 按 Agent 串行队列 | ✅ | `src/core/queue.mjs`（kimi 的 runner.lock 拒绝并发） |
| **圆桌成员超时** | ✅ | 单个成员挂住到点判超时、跳过并掐掉它，整轮秒级结束（`RELAYDECK_MEMBER_TIMEOUT_MS`） |
| **单条精确取消** | ✅ | 每轮有 runId + AbortController：`POST /api/cancel {runId\|agent\|all}`，取消不算失败、不触发自愈重试 |
| **续跑线自愈** | ✅ | 坏 session 自动丢弃重跑，如实上报 `contextReset`（`src/core/session-recovery.mjs`） |
| HTTP 层端到端验收 | ✅ | `evidence/http-e2e-*.json`：**11/11 项通过**（三组） |
| 边界验证 | ✅ | `evidence/boundary-*.json`：**10/10**（坏焦点/未绑定输入/未知 Agent/spawn 失败/超时/并发） |
| 会话失效自愈验收 | ✅ | `evidence/session-recovery-*.json`：**7/7** |
| **上游失败矩阵** | ✅ | `scripts/e2e-provider-failure.mjs`：**24/24**（挂住/截断/429/空回答/崩溃/慢但成功 + 圆桌成员挂住，自起服务不碰设备） |
| **精确取消验收** | ✅ | `scripts/e2e-cancel.mjs`：**10/10** |
| 单元测试 | ✅ | **127 项**，覆盖率 **98.2% 行 / 91.9% 分支 / 91.2% 函数**，fixture 全部来自真实抓取 |

**跨 Agent 接力的真实验收长这样**：先让 `dsh` 回答出「已记住 42」，再把它的回答作为引用上下文接力给下游 Agent——下游自己的会话里从未出现过 42，它答出 `42`，证明接力上下文确实送达。
对**没有续跑能力**的 Agent（MiniMax / Kimi）还会多验一轮：**不给接力上下文**再问一次，靠中台注入的历史答对，才算兜底真的生效。

## 快速开始

```bash
cd relay-deck
node server.mjs                 # 默认 http://127.0.0.1:8787
```

浏览器打开 `http://127.0.0.1:8787/`（左侧会话列表、中间消息流、右侧圆桌，左下角是 LED 真值表）。也可以用 `http://127.0.0.1:8787/?conversation=<会话id>` 直接打开某个会话。

### 命令行

```bash
node bin/relay.mjs agents                      # 列出已注册 Agent 与其命令路径
node bin/relay.mjs ask dsh "只回复 OK"
node bin/relay.mjs ask codex "只回复 OK" --cwd /tmp
node bin/relay.mjs ask dsh "继续刚才的话题" --session session-xxxx   # 续跑
node bin/relay.mjs ask dsh "..." --json        # 输出归一化事件 NDJSON
```

### 硬件（没有板子也能跑）

```bash
# 模拟器：直接驱动硬件命令链路
node bin/simulate.mjs led                      # 看当前 LED 真值表与 WS2812 帧
node bin/simulate.mjs demo                     # 跑一遍非模型的完整序列
node bin/simulate.mjs key S7 --copy            # 复制焦点句，并真的写进剪贴板
node bin/simulate.mjs key S1                   # 接力给第 1 个 Agent（会真调用模型）

# 全局热键守护进程：让按键不必先切到中台页面
swiftc -O tools/hotkeyd.swift -o tools/hotkeyd
./tools/hotkeyd --list        # 打印映射
./tools/hotkeyd --selftest    # 不通系统权限也能验证到中台的链路
./tools/hotkeyd               # 正式监听（需辅助功能权限）

# 实板工具（IOKit HID，零依赖）
swiftc -O tools/hidtool.swift -o tools/hidtool
./tools/hidtool list          # 找到 EasyInput 0x303A:0x1006 即成功
./tools/hidtool diagnose      # 逐个 report 试读写
./tools/hidtool agent-sweep   # 肉眼确认：暗蓝 → 红 → 绿 → 琥珀 → 熄灭

# 注意：以下命令会写入实体设备。板子若是别的任务在用，不要运行。
./tools/hidtool list          # 只读：确认设备身份
RELAYDECK_HID_BRIDGE=1 node server.mjs   # 会写设备：中台状态变化时写 0x12
```

板子侧只需要**配一组组合键**（⌥⌘1–5 / ⌥⌘←→ / ⌥⌘C / ⌥⌘B / ⌥⌘Esc）当作控制通道——阶段 2a 零固件改动；阶段 2b 再把它换成 BLE 结构化命令并获得 LED 回传。

## 键盘语义（网页与硬件共用一套）

| 输入 | 动作 | 说明 |
| --- | --- | --- |
| `1`–`5` / S1–S5 | **接力给第 N 个 Agent** | 携带当前焦点句作为引用上下文（发送） |
| `↑`/`↓`、`j`/`k` / 旋钮旋转 | 移动焦点句 | 只看，不发送 |
| `c` / S7 | 复制焦点句 | |
| `b` / S8 | 拉群 | 焦点句 + 问题广播给全部选中的 Agent |
| 旋钮短按 | 切换查看的 Agent | 只看，不发送 |
| `Enter` | 发送给当前查看的 Agent | Shift+Enter 换行 |
| `/` | 聚焦搜索框 | `Enter` / `n` 跳到下一个命中 |
| `Esc` / S6 | 清空焦点 | |

**按键 = 发送，旋钮 = 查看**：两个焦点（人 / 句子）语义正交，不需要模式切换，也就不违反"避免两级菜单"。

## 架构

```
web/ (原生 HTML/CSS/JS)                  tools/hotkeyd.swift (CGEventTap)
  │  焦点句 / 接力 / 圆桌 / LED 真值表      │  ⌥⌘… 组合键
  ▼                                       ▼
server.mjs  ── 中台 ──────────────────────┘
  ├── src/core/store.mjs      会话隔离 / 持久化(JSONL) / 搜索 / 接力链 / 用量
  ├── src/core/relay.mjs      接力上下文（引用式）与历史兜底（都有上限）
  ├── src/core/roundtable.mjs 受控并发 fan-out + 主持人汇总
  ├── src/core/queue.mjs      按 Agent 串行，跨 Agent 并行
  ├── src/core/runner.mjs     轮次执行器（stdin/argv/整体输出 / 超时 / 取消 / 失败判定）
  ├── src/hardware/keymap.mjs 硬件手势 → 中台命令
  └── src/hardware/led.mjs    中台状态 → 5 颗 WS2812 真值表与 GRB 帧
        │  spawn
        ▼
  src/adapters/*.mjs  ──►  dsh ｜ codex ｜ minimax ｜ kimi ｜（ZCode 待登录）
```

**新增一个 Agent = 新增一个适配器文件**，核心不用改：实现 `command()`、`buildArgs()`、`parseLine()` 或 `parseOutput()`。四个 Agent 的差异（行分隔流式 / 整体 JSON / argv 传正文 / 日志混流）都由适配器吃掉，见 [docs/adapter-contract.md](docs/adapter-contract.md)。

## 测试与验收

```bash
node --test                              # 127 项单测（覆盖率 98.2% 行 / 91.9% 分支）
node --test --experimental-test-coverage # 看覆盖率报告
node scripts/e2e-relay.mjs               # 真实接力（逐 Agent 验会话续跑）
node scripts/e2e-http.mjs                # HTTP 层端到端：默认验 dsh → codex
node scripts/e2e-http.mjs dsh minimax    # 换一对验（含历史兜底那一轮）
node scripts/e2e-http.mjs dsh kimi
node scripts/e2e-boundary.mjs            # 边界：坏输入 / spawn 失败 / 超时 / 并发
node scripts/e2e-session-recovery.mjs    # 续跑线失效自愈（脚本自己制造故障）
node scripts/e2e-board-status.mjs        # 板级状态帧：中台状态 → 要发给板的 16 字节
node scripts/e2e-cancel.mjs              # 单条精确取消（不影响并发的其他轮）
node scripts/e2e-provider-failure.mjs    # 弱网/上游失败矩阵（自起中台+假 provider，不碰设备）
node scripts/check-hardware.mjs          # 硬件就绪自检：什么已就绪、什么需要你操作
node scripts/check-delivery.mjs          # 交付物一致性：测试数/证据引用/脚本名/链接/编译产物
node scripts/check-fresh-clone.mjs       # 干净副本复现：git archive 导出后从头跑一遍验收
```

单测 fixture 全部来自**真实抓取**的输出，不是编造的。

## 九条来自实测的硬约束

1. **退出码不可信**：CLI 失败时退出码也可能是 `0`。判失败要靠"是否有文本 + 是否出现致命错误事件 + stderr"。
2. **警告 ≠ 失败**：Codex 先抛 `Under-development features enabled: chronicle`（条目级 error），随后正常回答；不区分 `fatal` 会把正确答案判成失败。
3. **同名子命令的参数签名可能不同**：`codex exec resume` 不接受 `--sandbox` / `-C`，选项还必须排在会话 id 之前。
4. **续跑会话必须按「会话 × Agent」隔离**，否则换话题时上游上下文会串进来。
5. **轮次去重只能按阶段、不能按身份**：主持人常常同时是参与者，按身份去重会吞掉参与者的那一轮。
6. **不是所有 CLI 都是行分隔流**：MiniMax 输出一个跨多行的 JSON；Kimi 把日志和回答混在同一个流里。执行器必须支持整体解析与日志过滤。
7. **历史注入超限时要丢最老的、留最新的**：正序拼接后整体截断会把最近一轮丢掉（已用回归测试锁住）。
8. **坏续跑线会把整个会话永久卡死**：上游 session 过期/被删后，每一轮都带同一个坏 id 失败，而且没有任何机制会清掉它。现在会丢掉旧线重跑一次，并如实上报"上下文已重置"。
9. **显式配置不能被静默忽略**：环境变量指向不存在的路径时若悄悄回退到 PATH，配错了也毫无提示；启动失败的错误也不能被适配器的"空输出"盖住。

## 已知限制（v1）

- ZCode 未接入（CLI 需要先完成一次 `zcode login`），见 [agent-onboarding.md](docs/agent-onboarding.md)；
- 搜索是**子串匹配**（不是语义检索），也不高亮句内位置；
- 会话支持新建 / 重命名 / 切换 / **软归档与恢复**；**不做硬删除**——接力链是这条链的证据，删了就找不回来；
- 硬件仍是 **2a 阶段**（HID 组合键 + 全局热键）：真正不看前台焦点、以及 LED 回传，要等阶段 2b 的 BLE 结构化命令；
- `data/` 只有本地持久化，没有多用户与鉴权（仅监听 127.0.0.1）。
