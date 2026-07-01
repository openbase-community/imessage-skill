import Foundation

struct Manifest: Codable {
    let copiedAt: String
    let sourceHost: String
    let files: [String]
}

let args = CommandLine.arguments
let runtimeDir: String = {
    if let idx = args.firstIndex(of: "--runtime-dir"), args.indices.contains(idx + 1) {
        return args[idx + 1]
    }
    return NSHomeDirectory() + "/.imessage-cli"
}()

let fm = FileManager.default
let inbox = URL(fileURLWithPath: runtimeDir).appendingPathComponent("inbox")
try fm.createDirectory(at: inbox, withIntermediateDirectories: true)

func setMode(_ url: URL, _ mode: Int) throws {
    try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
}

let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime]
let stamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
let partial = inbox.appendingPathComponent("\(stamp).partial")
let final = inbox.appendingPathComponent(stamp)
try? fm.removeItem(at: partial)
try fm.createDirectory(at: partial, withIntermediateDirectories: true)
try setMode(partial, 0o770)

var copied: [String] = []

func copyIfPresent(_ source: URL, named outputName: String? = nil) throws {
    guard fm.fileExists(atPath: source.path) else { return }
    let destination = partial.appendingPathComponent(outputName ?? source.lastPathComponent)
    try? fm.removeItem(at: destination)
    try fm.copyItem(at: source, to: destination)
    try setMode(destination, 0o660)
    copied.append(destination.lastPathComponent)
}

let home = URL(fileURLWithPath: NSHomeDirectory())
let messages = home.appendingPathComponent("Library/Messages")
try copyIfPresent(messages.appendingPathComponent("chat.db"))
try copyIfPresent(messages.appendingPathComponent("chat.db-wal"))
try copyIfPresent(messages.appendingPathComponent("chat.db-shm"))

let addressSources = home.appendingPathComponent("Library/Application Support/AddressBook/Sources")
if let enumerator = fm.enumerator(at: addressSources, includingPropertiesForKeys: [.isRegularFileKey]) {
    for case let url as URL in enumerator {
        let name = url.lastPathComponent
        if name.hasPrefix("AddressBook-") && (name.hasSuffix(".abcddb") || name.hasSuffix(".abcddb-wal") || name.hasSuffix(".abcddb-shm")) {
            try copyIfPresent(url)
        }
    }
}

let manifest = Manifest(
    copiedAt: formatter.string(from: Date()),
    sourceHost: Host.current().localizedName ?? "unknown",
    files: copied.sorted()
)
let manifestData = try JSONEncoder().encode(manifest)
let manifestURL = partial.appendingPathComponent("manifest.json")
try manifestData.write(to: manifestURL, options: .atomic)
try setMode(manifestURL, 0o660)

if fm.fileExists(atPath: final.path) {
    try fm.removeItem(at: final)
}
try fm.moveItem(at: partial, to: final)
try setMode(final, 0o770)
print("Copied \(copied.count) files to \(final.path)")
