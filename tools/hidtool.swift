// RelayDeck 实板工具（macOS / IOKit HID，无需任何第三方依赖）
//
// 用它在真机上完成阶段 2b 的两件事：
//   1. 把中台的 Agent 状态写成 HID Feature report 0x12（板子据此点灯）
//   2. 发状态请求 0x13，读回 0x11 输入报告里的 JSON —— 证明双向厂商 HID 通路可用
//   还有 watch：监听输入报告，用来验证按键真的发出了东西。
//
// 用法：
//   swiftc -O tools/hidtool.swift -o tools/hidtool
//   ./tools/hidtool list
//   ./tools/hidtool status
//   ./tools/hidtool agent running [seq] [ttlMs]
//   ./tools/hidtool agent failed | ok | waiting | idle
//   ./tools/hidtool watch [秒数]
//
// 协议事实来源（easy-input-maker）：
//   - Agent Status：report 0x12，Feature，16 字节（agent_status.h）
//   - 状态请求：report 0x13，Feature，16 字节，magic "S3R" + version + request_id(u32 LE) + flags
//   - 状态回传：report 0x11，Input，63 字节，JSON 从偏移 13 开始（status_hid_protocol.h）
import Foundation
import IOKit.hid

let kVendorID = 0x303A
let kProductID = 0x1006

let agentStates: [String: UInt8] = [
    "idle": 0, "running": 1, "waiting": 2, "ok": 3, "unread": 3, "failed": 4,
]

func errHex(_ value: IOReturn) -> String {
    String(format: "0x%08x", UInt32(bitPattern: Int32(value)))
}

func hex(_ bytes: ArraySlice<UInt8>) -> String {
    bytes.map { String(format: "%02x", $0) }.joined(separator: " ")
}

func ascii(_ bytes: ArraySlice<UInt8>) -> String {
    String(bytes.map { ($0 >= 32 && $0 < 127) ? Character(UnicodeScalar($0)) : "." })
}

/// 打开全部匹配 VID/PID 的 HID 接口（共享模式，不抢占，否则会抢走用户的键盘）
/// 板子会暴露多个 HID 接口（键盘 / 厂商自定义），厂商 report 只落在其中一个上。
func openDevices(seize: Bool = false) -> [IOHIDDevice] {
    let options = seize ? IOOptionBits(kIOHIDOptionsTypeSeizeDevice) : IOOptionBits(kIOHIDOptionsTypeNone)
    let manager = IOHIDManagerCreate(kCFAllocatorDefault, options)
    let matching: [String: Any] = [
        kIOHIDVendorIDKey as String: kVendorID,
        kIOHIDProductIDKey as String: kProductID,
    ]
    IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
    IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
    let openStatus = IOHIDManagerOpen(manager, options)
    if openStatus != kIOReturnSuccess {
        FileHandle.standardError.write("IOHIDManagerOpen 失败：\(errHex(openStatus))\n".data(using: .utf8)!)
    }
    // 给设备枚举一点时间
    CFRunLoopRunInMode(.defaultMode, 0.4, false)
    guard let set = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>, !set.isEmpty else {
        return []
    }
    // 厂商自定义接口优先（usagePage 0xFF00），其次是普通接口
    return Array(set).sorted { left, right in
        let leftVendor = (IOHIDDeviceGetProperty(left, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? 0) == 0xFF00
        let rightVendor = (IOHIDDeviceGetProperty(right, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? 0) == 0xFF00
        if leftVendor != rightVendor { return leftVendor }
        return false
    }
}

func deviceInfo(_ device: IOHIDDevice) -> String {
    let product = IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String ?? "?"
    let vid = IOHIDDeviceGetProperty(device, kIOHIDVendorIDKey as CFString) as? Int ?? -1
    let pid = IOHIDDeviceGetProperty(device, kIOHIDProductIDKey as CFString) as? Int ?? -1
    let usagePage = IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? -1
    let usage = IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsageKey as CFString) as? Int ?? -1
    let maxInput = IOHIDDeviceGetProperty(device, kIOHIDMaxInputReportSizeKey as CFString) as? Int ?? -1
    let maxFeature = IOHIDDeviceGetProperty(device, kIOHIDMaxFeatureReportSizeKey as CFString) as? Int ?? -1
    let maxOutput = IOHIDDeviceGetProperty(device, kIOHIDMaxOutputReportSizeKey as CFString) as? Int ?? -1
    return "\(product)  VID=0x\(String(vid, radix: 16)) PID=0x\(String(pid, radix: 16)) usagePage=0x\(String(usagePage, radix: 16)) usage=0x\(String(usage, radix: 16)) maxIn=\(maxInput) maxFeature=\(maxFeature) maxOut=\(maxOutput)"
}

/// 在所有接口上尝试写 Feature report，返回 (成功的接口序号, 结果)
func setFeature(_ targets: [IOHIDDevice], reportID: UInt8, payload: [UInt8], includeID: Bool) -> (Int, IOReturn) {
    var buffer: [UInt8] = includeID ? [reportID] + payload : payload
    let length = CFIndex(buffer.count)
    var last: IOReturn = kIOReturnError
    for (index, device) in targets.enumerated() {
        let result = buffer.withUnsafeMutableBufferPointer { pointer -> IOReturn in
            IOHIDDeviceSetReport(device, kIOHIDReportTypeFeature, CFIndex(reportID), pointer.baseAddress!, length)
        }
        if result == kIOReturnSuccess { return (index, result) }
        last = result
    }
    return (-1, last)
}

// —— 输入报告收集 ——
var collectedChunks: [UInt8: [UInt8]] = [:]
var totalChunks: UInt8 = 0
var inputReportCount = 0

let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 256)
inputBuffer.initialize(repeating: 0, count: 256)

let inputCallback: IOHIDReportCallback = { _, _, _, _, reportID, report, reportLength in
    inputReportCount += 1
    var bytes = [UInt8]()
    for index in 0..<Int(reportLength) { bytes.append(report[index]) }
    // 有的实现会把 report id 放在首字节，这里统一剥掉
    var payload = bytes
    if let first = payload.first, first == UInt8(reportID), payload.count > 1 {
        payload.removeFirst()
    }
    if reportID == 0x11, payload.count >= 13, payload[0] == 0x04 {
        let chunkIndex = payload[1]
        let chunks = payload[2]
        let jsonLength = Int(payload[3])
        totalChunks = chunks
        let dataLength = jsonLength - 9
        if dataLength > 0 {
            let end = min(13 + dataLength, payload.count)
            collectedChunks[chunkIndex] = Array(payload[13..<end])
        }
        print("[0x11] chunk \(chunkIndex + 1)/\(chunks)  jsonSize=\(UInt16(payload[9]) | (UInt16(payload[10]) << 8))  \(hex(payload[0..<min(13, payload.count)]))")
    } else if reportID != 0x11 {
        print("[0x\(String(reportID, radix: 16))] len=\(payload.count) \(hex(payload.prefix(24)))  |\(ascii(payload.prefix(32)))|")
    }
}

func pump(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        CFRunLoopRunInMode(.defaultMode, 0.1, false)
    }
}

func assembledJSON() -> String? {
    guard totalChunks > 0, collectedChunks.count == Int(totalChunks) else { return nil }
    var bytes = [UInt8]()
    for index in 0..<totalChunks {
        guard let chunk = collectedChunks[index] else { return nil }
        bytes.append(contentsOf: chunk)
    }
    return String(bytes: bytes, encoding: .utf8)
}

/// 读回 feature 0x12（当前 Agent 状态）
func readAgentStatus(_ device: IOHIDDevice) -> [UInt8]? {
    var buffer = [UInt8](repeating: 0, count: 64)
    var length = CFIndex(17)
    let result = buffer.withUnsafeMutableBufferPointer { pointer -> IOReturn in
        IOHIDDeviceGetReport(device, kIOHIDReportTypeFeature, CFIndex(0x12), pointer.baseAddress!, &length)
    }
    guard result == kIOReturnSuccess else {
        print("  GetReport(0x12) 失败：\(errHex(result))")
        return nil
    }
    // IOKit 会把 report id 放在首字节
    if buffer.first == 0x12 { return Array(buffer[1..<17]) }
    return Array(buffer[0..<16])
}

func describeAgent(_ payload: [UInt8]) -> String {
    let stateNames = ["Idle", "Running", "WaitingUser", "CompletedUnread", "Failed"]
    let state = Int(payload[1])
    let sequence = UInt32(payload[4]) | (UInt32(payload[5]) << 8) | (UInt32(payload[6]) << 16) | (UInt32(payload[7]) << 24)
    let ttl = UInt32(payload[8]) | (UInt32(payload[9]) << 8) | (UInt32(payload[10]) << 16) | (UInt32(payload[11]) << 24)
    let name = state < stateNames.count ? stateNames[state] : "?"
    return "state=\(name)(\(state)) seq=\(sequence) ttl=\(ttl)ms ver=\(payload[0])"
}

/// 诊断：显式打开设备，逐个 report 试读写，定位到底卡在哪一步
func diagnose(_ targets: [IOHIDDevice]) {
    for (index, device) in targets.enumerated() {
        print("\n—— 接口 \(index) ——")
        if let descriptor = IOHIDDeviceGetProperty(device, kIOHIDReportDescriptorKey as CFString) as? Data {
            print("report descriptor 长度：\(descriptor.count) 字节")
        } else {
            print("拿不到 report descriptor")
        }

        let openResult = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        print("IOHIDDeviceOpen：\(errHex(openResult))\(openResult == kIOReturnSuccess ? " ✓" : "")")

        // Feature 读
        var readBuffer = [UInt8](repeating: 0, count: 64)
        var readLength = CFIndex(16) // GetReport 的长度是 in/out 参数
        let readResult = readBuffer.withUnsafeMutableBufferPointer { pointer -> IOReturn in
            IOHIDDeviceGetReport(device, kIOHIDReportTypeFeature, CFIndex(0x12), pointer.baseAddress!, &readLength)
        }
        print("GetReport(feature 0x12)：\(errHex(readResult))  返回长度=\(readLength) 数据=\(hex(readBuffer[0..<16]))")

        // Feature 写：逐个 report 与两种约定
        for reportID in [0x12, 0x13, 0x10] as [UInt8] {
            for includeID in [true, false] {
                let payload = [UInt8](repeating: 0x5a, count: reportID == 0x10 ? 63 : 16)
                var buffer: [UInt8] = includeID ? [reportID] + payload : payload
                let length = CFIndex(buffer.count)
                let result = buffer.withUnsafeMutableBufferPointer { pointer -> IOReturn in
                    IOHIDDeviceSetReport(device, kIOHIDReportTypeFeature, CFIndex(reportID), pointer.baseAddress!, length)
                }
                print("SetReport(feature 0x\(String(reportID, radix: 16)), \(includeID ? "含 id" : "不含 id"), \(buffer.count) 字节)：\(errHex(result))\(result == kIOReturnSuccess ? " ✓" : "")")
            }
        }
        IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
    }
}

// —— 命令行 ——
let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "help"

let seizeMode = args.contains("--seize")
let devices = openDevices(seize: seizeMode)
if seizeMode { print("（独占模式：测试结束会释放）") }
guard !devices.isEmpty else {
    FileHandle.standardError.write(
        "没找到 EasyInput（VID 0x303A / PID 0x1006）。确认板子已插上且处于正常模式。\n".data(using: .utf8)!
    )
    exit(2)
}
for (index, item) in devices.enumerated() {
    print("接口 \(index)：\(deviceInfo(item))")
}
// 每个接口都要**显式打开**：实测只调 IOHIDManagerOpen 时 SetReport 会返回
// kIOReturnNotReadable(0xe00002cd)，显式 IOHIDDeviceOpen 之后才真正可写。
var opened: [IOHIDDevice] = []
for item in devices {
    let result = IOHIDDeviceOpen(item, IOOptionBits(kIOHIDOptionsTypeNone))
    if result != kIOReturnSuccess {
        print("IOHIDDeviceOpen 失败：\(errHex(result))")
    } else {
        opened.append(item)
    }
    IOHIDDeviceRegisterInputReportCallback(item, inputBuffer, 256, inputCallback, nil)
}

switch command {
case "list":
    print("已找到上述设备（这就是 ioreg 里那台 EasyInput AI）")

case "status":
    // 状态请求：magic "S3R" + version + request_id(u32 LE) + flags(0x01 = 取样最新)
    let requestID = UInt32(Date().timeIntervalSince1970) & 0xFFFF_FFFF
    var request = [UInt8](repeating: 0, count: 16)
    request[0] = UInt8(ascii: "S"); request[1] = UInt8(ascii: "3"); request[2] = UInt8(ascii: "R")
    request[3] = 1
    request[4] = UInt8(requestID & 0xff)
    request[5] = UInt8((requestID >> 8) & 0xff)
    request[6] = UInt8((requestID >> 16) & 0xff)
    request[7] = UInt8((requestID >> 24) & 0xff)
    request[8] = 0x01

    print("发送状态请求 0x13（request_id=\(requestID)）…")
    var includeID = true
    var (iface, result) = setFeature(devices, reportID: 0x13, payload: request, includeID: true)
    print("SetReport(0x13, 带 report id)：\(errHex(result))\(result == kIOReturnSuccess ? " ✓ 接口 \(iface)" : "")")
    pump(2.0)

    if inputReportCount == 0 {
        print("没收到回传，换一种缓冲区约定再试（不带 report id）…")
        includeID = false
        (iface, result) = setFeature(devices, reportID: 0x13, payload: request, includeID: false)
        print("SetReport(0x13, 不带 report id)：\(errHex(result))\(result == kIOReturnSuccess ? " ✓ 接口 \(iface)" : "")")
        pump(2.0)
    }

    if let json = assembledJSON() {
        print("\n=== 设备回传的 JSON（证明双向厂商 HID 通路可用）===")
        print(json)
        print("\n采用的有效约定：\(includeID ? "缓冲区包含 report id" : "缓冲区不含 report id")")
    } else {
        print("没有拼出完整 JSON（收到输入报告 \(inputReportCount) 条）")
        print("提示 1：收不到回传通常是**输入监控权限**没给——")
    print("        系统设置 → 隐私与安全性 → 输入监控 → 勾选你的终端，然后重开终端再试。")
    print("        （IOKit 读取 HID 输入报告需要它，和 EasyInput.app 要的是同一类权限。）")
    print("提示 2：若 SetReport 失败，可试 ./tools/hidtool status --seize（独占接口，测完自动释放）")
        exit(1)
    }

case "agent":
    let stateName = args.count > 2 ? args[2] : "running"
    guard let state = agentStates[stateName] else {
        FileHandle.standardError.write("未知状态：\(stateName)（可用：\(agentStates.keys.sorted().joined(separator: ", "))）\n".data(using: .utf8)!)
        exit(2)
    }
    let sequence = args.count > 3 ? UInt32(args[3]) ?? 1 : 1
    let ttlMs = args.count > 4 ? UInt32(args[4]) ?? 60000 : 60000
    var payload = [UInt8](repeating: 0, count: 16)
    payload[0] = 1 // 协议版本
    payload[1] = state
    payload[2] = 0
    payload[3] = 0
    func writeU32(_ value: UInt32, at offset: Int) {
        payload[offset] = UInt8(value & 0xff)
        payload[offset + 1] = UInt8((value >> 8) & 0xff)
        payload[offset + 2] = UInt8((value >> 16) & 0xff)
        payload[offset + 3] = UInt8((value >> 24) & 0xff)
    }
    writeU32(sequence, at: 4)
    writeU32(state == 0 ? 0 : ttlMs, at: 8)
    writeU32(0x5244_4C59, at: 12) // "RDLY" 作为来源哈希，便于在日志里认出是中台发的

    print("发送 Agent Status 0x12：state=\(stateName)(\(state)) seq=\(sequence) ttl=\(ttlMs)ms")
    let (iface, result) = setFeature(devices, reportID: 0x12, payload: payload, includeID: true)
    print("SetReport(0x12)：\(errHex(result))\(result == kIOReturnSuccess ? " ✓ 已被设备接受（接口 \(iface)）" : "")")
    print("载荷：\(hex(payload[0..<16]))")
    if result != kIOReturnSuccess { exit(1) }

case "watch":
    let seconds = args.count > 2 ? Double(args[2]) ?? 10 : 10
    print("监听输入报告 \(seconds) 秒…（现在按板子上的按键）")
    print("若一条都没有：多数是缺「输入监控」权限（系统设置 → 隐私与安全性 → 输入监控）")
    pump(seconds)
    print("共收到 \(inputReportCount) 条输入报告")

case "agent-verify":
    // 读 → 写 → 再读：如果读回的状态跟着变了，就证明 feature 写真的落到了设备状态里
    guard let target = opened.first else { print("没有可用接口"); exit(1) }
    print("\n[1] 写入前读取：")
    guard let before = readAgentStatus(target) else { exit(1) }
    print("    \(describeAgent(before))")

    var payload = [UInt8](repeating: 0, count: 16)
    payload[0] = 1
    payload[1] = 1 // Running
    payload[4] = 7 // seq = 7
    payload[8] = 0x60; payload[9] = 0xEA // ttl = 60000
    payload[12] = 0x59; payload[13] = 0x4C; payload[14] = 0x44; payload[15] = 0x52 // "RDLY"
    let writeResult = setFeature([target], reportID: 0x12, payload: payload, includeID: true)
    print("\n[2] 写入 Running / seq=7：\(errHex(writeResult.1))\(writeResult.1 == kIOReturnSuccess ? " ✓" : "")")
    pump(0.5)

    print("\n[3] 写入后读取：")
    guard let after = readAgentStatus(target) else { exit(1) }
    print("    \(describeAgent(after))")

    let changed = after != before
    print("\n注意：固件的 tud_hid_get_report_cb 是空实现（直接 return 0），")
    print("      所以读回恒为全零，**不能**用它判断写入有没有生效。")
    print("      feature 写本身已被 USB 栈接受（上面返回成功）；是否真的驱动了灯，")
    print("      只能用眼睛确认——请跑 ./tools/hidtool agent-sweep。")
    print("\n读回是否变化：\(changed ? "变了" : "没变（符合预期：GET_REPORT 未实现）")")
    exit(0)

case "agent-sweep":
    // 用肉眼可分辨的顺序走一遍五个状态，并且**用纪元序号**（赢过 BLE 侧，避免被丢弃）
    guard let target = opened.first else { print("没有可用接口"); exit(1) }
    let base = UInt32(Date().timeIntervalSince1970)
    let plan: [(String, UInt8, Double)] = [
        ("Running（暗蓝）", 1, 2.5),
        ("Failed（红）", 4, 2.5),
        ("CompletedUnread（绿）", 3, 2.5),
        ("WaitingUser（琥珀）", 2, 2.5),
        ("Idle（熄灭）", 0, 0),
    ]
    print("\n即将按顺序点灯，请在板子上看 5 颗灯：")
    print("  暗蓝 → 红 → 绿 → 琥珀 → 熄灭")
    print("（序号从 \(base) 起算，确保能赢过桌面 App 的序号）\n")
    for (index, step) in plan.enumerated() {
        let (name, state, hold) = step
        var payload = [UInt8](repeating: 0, count: 16)
        payload[0] = 1
        payload[1] = state
        let sequence = base + UInt32(index) * 10
        func writeU32(_ value: UInt32, at offset: Int) {
            payload[offset] = UInt8(value & 0xff)
            payload[offset + 1] = UInt8((value >> 8) & 0xff)
            payload[offset + 2] = UInt8((value >> 16) & 0xff)
            payload[offset + 3] = UInt8((value >> 24) & 0xff)
        }
        writeU32(sequence, at: 4)
        writeU32(state == 0 ? 0 : 8000, at: 8)
        writeU32(0x5244_4C59, at: 12)
        let (_, result) = setFeature([target], reportID: 0x12, payload: payload, includeID: true)
        print("  已发 \(name)  seq=\(sequence)  → \(errHex(result))\(result == kIOReturnSuccess ? " ✓" : "")")
        if hold > 0 { pump(hold) }
    }
    print("\n完成。若你在板子上看到了「暗蓝 → 红 → 绿 → 琥珀 → 熄灭」，")
    print("就证明中台的 16 字节状态帧真的驱动了这 5 颗灯。")
    print("若完全没变化，请检查：①板子固件是否包含 Agent Status（report 0x12）这条路径；")
    print("②BLE 是否同时连接并占了更高的序号。")

case "diagnose":
    diagnose(devices)

default:
    print("""
    RelayDeck 实板工具

      list                     找到设备即成功
      status                   发状态请求 0x13 并读回 JSON
      agent <状态> [seq] [ttl] 写 Agent Status 0x12（idle/running/waiting/ok/failed）
      watch [秒数]              监听输入报告（验证按键）
      diagnose                 逐个 report 试读写，定位卡在哪一步
      agent-verify             读→写→再读（注意：GET_REPORT 未实现，读回无效）
      agent-sweep              肉眼确认用的灯色序列：暗蓝→红→绿→琥珀→熄灭
    """)
}
