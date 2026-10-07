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

## 六、实板实测记录（2026-10-07，板子已插上 USB）

用 `tools/hidtool.swift`（IOKit HID，零依赖；`swiftc -O tools/hidtool.swift -o tools/hidtool`）在真机上跑出来的结果：

### 已验证 ✅

| 项 | 结果 |
| --- | --- |
| 设备身份 | `EasyInput AI`，VID `0x303A` / PID `0x1006`，序列号字符串 `easy-input-v2`（ioreg 与 IOKit 两边一致） |
| HID 接口 | 只暴露 **1 个** 接口：usagePage `0x1` / usage `0x6`（键盘），`maxInput=64`、`maxFeature=64`、报告描述符 250 字节 |
| Feature 写通路 | `SetReport(0x12 / 0x13 / 0x10)` **全部返回 `0x00000000` 成功** |
| 灯色序列已下发 | 用纪元序号依次发 Running→Failed→CompletedUnread→WaitingUser→Idle，5 帧全部被 USB 栈接受 |

### 踩到的坑 ⚠️

1. **只调 `IOHIDManagerOpen` 不够**：此时 `SetReport` 会返回 `0xe00002cd`（`kIOReturnNotReadable`）。
   必须对每个设备显式调 **`IOHIDDeviceOpen`**，之后 feature 写才真正成功。这是最容易卡住的一步。
2. **固件的 `GET_REPORT` 是空实现**：`tud_hid_get_report_cb` 直接 `return 0`。
   所以"读回 Agent 状态"这条路**不存在**——读回恒为全零，不能用它判断写入是否生效。
3. **读输入报告需要 macOS「输入监控」权限**：状态请求 0x13 的回传走 0x11 输入报告，
   没有该权限时 IOKit 的回调一条都不会触发（现象是"发了请求没反应"）。
   权限位置：系统设置 → 隐私与安全性 → 输入监控（与 EasyInput.app 需要的辅助功能是两回事）。

### 关键约束：序号仲裁 🔎

固件在 `apply_pending_agent_status()` 里同时收 BLE 与 USB 两条来源：

```cpp
if (!pending || agent_status_sequence_is_newer(usb_command.sequence, selected.sequence))
    selected = usb_command;   // 否则这一帧被丢弃
```

**这意味着中台的序号必须天生比桌面 App 的更大**，否则发出去的帧会被静默丢弃，
现象就是"灯不跟着中台走"。已在主机侧实现：`epochSequence()` 从当前时间秒数起算，
而不是从 0 起算；单测锁住了"纪元序号必须胜过从 0 起算的序号"。

### 中台 → 板子 回路已跑通 ✅

```bash
RELAYDECK_HID_BRIDGE=1 node server.mjs   # 状态一变就自动写 0x12
```

实测服务日志（按一下硬件 S3 触发一次真实接力）：

```
[14:26:43] led 板级状态 → Idle（seq=717641371）
[14:26:43] bridge → idle seq=717641371
[14:26:43] hardware key S3 → 接力给第 3 个 Agent ok
[14:26:43] led 板级状态 → Running（seq=717641372）
[14:26:43] bridge → running seq=717641372
[14:26:46] hardware relay→minimax ok=true
（随后 CompletedUnread，绿灯）
```

`SetReport` 全部返回 `0x00000000`，说明主机侧这条通路是通的。
`src/hardware/bridge.mjs` 负责调工具，纯逻辑部分有 5 项单测（工具缺失自动禁用、参数正确、重复帧不重发、异常被吞掉）。

### 仍然只能肉眼确认的部分 ❓

灯到底亮没亮——主机侧**没有任何可读回的通路**（GET_REPORT 未实现、没有串口日志）。
所以最后一步是一条命令 + 一双眼睛：

```bash
./tools/hidtool agent-sweep     # 暗蓝 → 红 → 绿 → 琥珀 → 熄灭
```

看到这个顺序，就证明中台的 16 字节状态帧真的驱动了这 5 颗灯。
若完全没变化，按顺序排查：①`agent status` 日志是否出现（需要串口/JTAG 日志）；
②同时连接的 BLE 是否占了更高序号；③板子上的固件是否包含 Agent Status 这条路径
（当前板子跑的是精听台阶段烧的 `0.4.53-idf-v2-ble-store-v1`，需要确认它是否含该功能）。
