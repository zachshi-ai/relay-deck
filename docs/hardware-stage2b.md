# 阶段 2b · 实板接入清单

板子还没拿到手，但**已经把路探清了**。最重要的发现是：**LED 回传通道固件里已经有了，不需要自己造。**

## 一、核心发现：Agent Status 协议 v1 已存在

`easy-input-maker` 里已经定义了「把 Agent 状态显示到 5 颗灯」的完整链路：

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 协议定义 | `components/keyboard/include/keyboard/agent_status.h` | 16 字节，report ID `0x12`，含 5 个状态与 TTL |
| USB 声明 | `main/platform/usb_hid.cpp` | report descriptor 里已声明 `0x85, 0x12`（Report ID 18） |
| BLE 入口 | `main/platform/ble_hid.cpp` | `s_agent_status_write_handle` 写入句柄 |
| 灯效映射 | `main/platform/led_strip_status.cpp` 的 `agent_status_color()` | 状态 → RGB |
| 宿主测试 | `host_test/agent_status_tests.cpp` | 已有覆盖 |

**结论**：主机侧只要把中台状态编码成这 16 字节发出去，板子就会自己点灯。**不用改固件、不用碰 GPIO8 电源时序。**

### 字节布局（与固件解码端逐字节一致）

```
byte 0      version = 1
byte 1      state（0 Idle / 1 Running / 2 WaitingUser / 3 CompletedUnread / 4 Failed）
byte 2      flags
byte 3      reserved = 0
byte 4..7   sequence   小端 u32
byte 8..11  ttl_ms     小端 u32（固件上限 12 小时；state=Idle 时必须为 0）
byte 12..15 source_hash 小端 u32
```

### 状态映射（中台 → 固件 → 灯色）

| 中台 runStatus | 固件状态 | 灯色（固件定义） |
| --- | --- | --- |
| `running` | Running | 暗蓝 `(0,0,28)` |
| `error` | Failed | 红 `(30,0,8)` |
| `ok`（未读） | CompletedUnread | 绿 `(0,24,5)` |
| `ok`（已读） | Idle | 熄灭 |
| `waiting` | WaitingUser | 琥珀 `(30,12,0)` |

### 两个必须说清的渲染语义（我第一版理解得太粗，这里纠正）

读完 `led_strip_status.cpp` 之后确认：

1. **板子一次只显示一个状态**：`set_agent_status()` 保存单个 `agent_status_`，后到的覆盖先到的。
2. **它把这一种颜色铺成 5 颗灯的径向渐变**：`render_agent_status()` 里，中心灯满亮、相邻灯 50%、其余 25%。**不是"每个 Agent 一颗灯"**。
3. **完全相同的帧会被丢弃**（state/flags/sequence/ttl/source 全同），所以 sequence 只在状态变化时才需要递增。
4. `source_hash` 只参与去重与日志，**不参与选灯**。

因此中台侧必须先把各 Agent 的状态**收敛成一件最该被看到的事**（`buildBoardStatus`）：

```
优先级：在跑 > 失败 > 有结果未读 > 在等用户 > 空闲
```

界面左下角那张"每个 Agent 一颗灯"的真值表（`led.mjs`）是**中台自己的可视化**，与板子显示的不是同一套编码——把两者混为一谈会让人以为板子能显示 5 个 Agent 的状态。要真做到那样，需要改固件（方案 b），当前不做。

**这部分主机侧已经实现并测好了**：

- `src/hardware/agent-status.mjs`：编码/解码、TTL 上限夹紧、Idle 归零、非法帧拒绝、序号回绕比较、**聚合优先级**
- `test/agent-status.test.mjs`：10 项单测（共 78 项单测的一部分）
- `scripts/e2e-board-status.mjs`：**13/13 通过**——在没有板子的情况下，把"中台状态 → 要发给板的 16 字节"整条链路验通：
  - 基线 Idle 且 TTL 为 0
  - **按下硬件键后，响应体里的那一帧就已经是 Running**（这里修过一个真问题：状态原本是异步才置上的，桥接层照那帧点灯会漏掉"正在跑"）
  - Running 的 TTL = 600000，sequence 递增
  - 轮次结束 → CompletedUnread（绿 `(0,24,5)`）
  - 用户一动 → 回到 Idle（灯灭）
  - 状态没变时重复读取不刷 sequence


## 二、还差的就是"怎么把 16 字节发出去"

USB 与 BLE 两条路都在，但 Node 没有内置 HID/GATT 写入能力，需要选一条：

| 路径 | 做法 | 取舍 |
| --- | --- | --- |
| **USB HID output report `0x12`** | 通过 `hidapi` 类原生模块，或复用 EasyInput.app 已有的写入通道 | 有线时最稳；引入一个原生依赖 |
| **BLE GATT 写入** | 连到板子对应 characteristic 写同样的载荷 | 无线；需要 BLE 库，且要处理重连 |
| 保持现状（不发） | 只用 HID 组合键控制（阶段 2a 已完成） | 零依赖，但没有灯效回传 |

**待验证（我还没确认，不许当结论）**：

1. 那个 BLE characteristic 的 UUID 与服务定义；
2. EasyInput.app 是否已经封装了 agent status 写入（如果有，可以复用它的进程间通道，避免自己接 HID）；
3. 板子在 USB 与 BLE 同时连接时，agent status 的来源优先级与去重规则（固件里有 `source_hash` 与 `sequence`，推测是按来源区分，但没读到策略代码）。

## 三、上行（按键）现状

- **阶段 2a 已完成**：板子发 HID 组合键 → 全局热键守护进程 → 中台。零固件改动。
- **可选升级**：用固件里已有的 Host Action v1（report `0x11` / command kind `0x05`，36 字节 UUID 动作标识）替代组合键。这需要在固件里给按键绑定我们的动作 UUID——**要改固件**，收益是语义更干净、不占用系统快捷键；留到实板阶段评估。

## 四、实板阶段必须遵守的边界

来自 `easy-input-maker/AGENTS.md` 与 `docs/hardware/easyinput-v2-safety.md`：

- 不动 GPIO 分配、BOOT 流程、分区表、设备身份、通信协议与 **GPIO8 共享电源生命周期**（LED/麦克风/扬声器共用这一路电）；
- 不提交真实 Wi-Fi 凭据、同步密钥、设备唯一标识；日志不得输出密码、SSID、用户文本；
- **构建通过 / 自动测试通过 / 烧录成功 / 实板功能正常是四种不能互相替代的证据**，报告时必须分开写。

## 五、实板验收计划

| 步骤 | 命令 | 期望证据 |
| --- | --- | --- |
| 1. 宿主测试 | `cmake -S host_test -B build-host && cmake --build build-host && ctest --test-dir build-host` | 全绿；重点看 `agent_status_tests` |
| 2. 固件构建 | `idf.py build`（ESP-IDF 5.5.5） | `Project build complete` |
| 3. 烧录 | 按仓库的 `scripts/` 流程，先擦 NVS 再烧 | `Hash of data verified` |
| 4. 设备身份 | 只读查询 | USB 身份回到 `EasyInput AI`（0x303A:0x1006） |
| 5. **按键实测** | 配 ⌥⌘ 组合键，按 S1–S8 | 中台日志出现对应的 relay/focus/copy/roundtable |
| 6. **灯效实测** | 发 report `0x12`，覆盖 5 个状态 | 肉眼确认五色与 `AGENT_STATUS_COLORS` 一致 |
| 7. 状态机联动 | 发起一轮真实接力 | 灯从 Idle → Running（暗蓝）→ CompletedUnread（绿） |

第 5、6、7 步是我目前**唯一没有实测的东西**——板子回来后按这个顺序做，做完把结果写回作业正文的 §6（把"未完成"改成实测结论）。
