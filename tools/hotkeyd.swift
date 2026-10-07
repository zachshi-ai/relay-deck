// RelayDeck 全局热键守护进程（macOS）
//
// 为什么需要它：网页端只有在浏览器位于前台时才能收到键盘事件，而接力台的价值
// 恰恰是「手不离键盘、眼睛不离开当前工作」。这个守护进程用 CGEventTap 在系统层
// 接住 EasyInput 发出的组合键，转成一条 HTTP 请求打给中台，再把事件吞掉
// （不让 ⌥⌘1 泄漏到前台应用里）。
//
// 用法：
//   swiftc -O tools/hotkeyd.swift -o tools/hotkeyd
//   ./tools/hotkeyd --list        # 打印组合键映射，不监听
//   ./tools/hotkeyd --selftest    # 向中台发一遍非模型动作，验证通路，不监听
//   ./tools/hotkeyd               # 正式监听（需要辅助功能权限）
//
// 权限：系统设置 → 隐私与安全性 → 辅助功能，勾选运行它的终端（或直接给这个可执行文件）。
// 环境变量：RELAYDECK_HARDWARE_URL 覆盖中台地址。
import Foundation
import CoreGraphics

let hubURL = URL(
    string: ProcessInfo.processInfo.environment["RELAYDECK_HARDWARE_URL"]
        ?? "http://127.0.0.1:8787/api/hardware"
)!

/// 与 src/hardware/keymap.mjs 的 DEFAULT_HID_KEYMAP 必须保持一致
let keyNames: [Int64: String] = [
    18: "digit1", 19: "digit2", 20: "digit3", 21: "digit4", 23: "digit5",
    123: "arrowleft", 124: "arrowright",
    8: "keyc", 11: "keyb", 53: "escape",
]

let selftestCombos = ["alt+meta+arrowright", "alt+meta+arrowleft", "alt+meta+keyc", "alt+meta+escape"]

func comboName(keyCode: Int64, flags: CGEventFlags) -> String? {
    guard flags.contains(.maskAlternate), flags.contains(.maskCommand) else { return nil }
    guard let name = keyNames[keyCode] else { return nil }
    var parts: [String] = []
    if flags.contains(.maskControl) { parts.append("ctrl") }
    parts.append("alt")
    if flags.contains(.maskShift) { parts.append("shift") }
    parts.append("meta")
    parts.append(name)
    return parts.joined(separator: "+")
}

func post(combo: String) {
    var request = URLRequest(url: hubURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["source": "hid", "combo": combo])
    request.timeoutInterval = 5

    let semaphore = DispatchSemaphore(value: 0)
    var summary = "无响应"
    URLSession.shared.dataTask(with: request) { data, _, error in
        defer { semaphore.signal() }
        if let error = error {
            summary = "请求失败：\(error.localizedDescription)"
            return
        }
        guard let data = data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            summary = "返回内容无法解析"
            return
        }
        let accepted = (object["accepted"] as? Bool) ?? false
        let action = (object["action"] as? String) ?? "?"
        let reason = (object["reason"] as? String) ?? ""
        let led = (object["led"] as? [String: Any])?["summary"] as? String ?? ""
        summary = accepted ? "\(action) ✓  \(led)" : "\(action) ✗ \(reason)"
    }.resume()
    semaphore.wait()
    print("[hotkeyd] \(combo) → \(summary)")
    fflush(stdout)
}

let arguments = CommandLine.arguments

if arguments.contains("--help") || arguments.contains("-h") {
    print("""
    RelayDeck 全局热键守护进程

      --list       打印组合键映射（不监听）
      --selftest   向中台发一遍非模型动作，验证通路（不监听）
      （无参数）   正式监听，需要辅助功能权限

    环境变量 RELAYDECK_HARDWARE_URL 可覆盖中台地址，默认 \(hubURL.absoluteString)
    """)
    exit(0)
}

if arguments.contains("--list") {
    let pretty: [(String, String)] = [
        ("⌥⌘1…⌥⌘5", "接力给第 1…5 个 Agent（发送）"),
        ("⌥⌘→", "焦点下一句"),
        ("⌥⌘←", "焦点上一句"),
        ("⌥⌘C", "复制焦点句"),
        ("⌥⌘B", "拉群并汇总"),
        ("⌥⌘Esc", "清空焦点"),
    ]
    for (combo, meaning) in pretty {
        print("  \(combo.padding(toLength: 12, withPad: " ", startingAt: 0)) \(meaning)")
    }
    exit(0)
}

if arguments.contains("--selftest") {
    print("[hotkeyd] 自检：向 \(hubURL.absoluteString) 发送 \(selftestCombos.count) 个非模型动作")
    for combo in selftestCombos { post(combo: combo) }
    exit(0)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // 系统在超时后会临时禁用 tap，这里需要自己恢复，否则热键会静默失效
        print("[hotkeyd] 事件监听被系统暂停，等待恢复")
        return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown else { return Unmanaged.passUnretained(event) }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    if let hit = comboName(keyCode: keyCode, flags: event.flags) {
        post(combo: hit)
        return nil // 吞掉，避免 ⌥⌘1 之类泄漏给前台应用
    }
    return Unmanaged.passUnretained(event)
}

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: callback,
    userInfo: nil
) else {
    FileHandle.standardError.write(
        """
        无法创建系统事件监听。
        请在「系统设置 → 隐私与安全性 → 辅助功能」里勾选你运行它的终端应用（或本可执行文件），然后重试。

        """.data(using: .utf8)!
    )
    exit(1)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("[hotkeyd] 已启动，监听 ⌥⌘1–5 / ⌥⌘←→ / ⌥⌘C / ⌥⌘B / ⌥⌘Esc → \(hubURL.absoluteString)")
fflush(stdout)
CFRunLoopRun()
