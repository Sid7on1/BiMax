import Foundation
import BimaxCuProtocol
import BimaxComputerUseKit

/// `bimax-cu-bridge --stdio` — the process boundary between the Electron host and the CU engine.
///
/// RECONSTRUCTION NOTE (2026-08-18): this executable's sources were lost with the FocusBridge
/// eviction and the package would not build. The contract below is not invented — every rule is
/// pinned by the host that spawns it (`app/src/capabilities/mac/native.bridge.transport.ts`,
/// itself recovered from the compiled bundle):
///
///   - spawned as `bimax-cu-bridge --stdio`, speaking ONE JSON line per request on stdin and ONE
///     JSON line per reply on stdout; stderr is logs, never protocol;
///   - request:  `{protocol, requestId, sessionId, deadlineMs, body: {op, payload?}}` — the
///     protocol's `RequestEnvelope`, ≤ 2 MiB;
///   - reply:    `{requestId, response: <ResponseEnvelope>}` on success, or
///     `{requestId, error: {code, message}}` when the bridge itself failed (the host treats a
///     top-level error as a transport failure and a response.error as a service failure);
///   - the host runs strictly one exchange at a time and condemns the process on an unsolicited
///     line — so this loop is sequential, reads to EOF, and never writes anything unasked;
///   - the embedded engine is `BimaxCuServiceCore` (the same core the XPC service hosts); the
///     bridge is its stdio host, which is why the target depends on the whole Kit rather than
///     the protocol library alone.
///
/// The engine call is synchronous (its operations bound themselves against the envelope's
/// deadline); the bridge adds no second timeout on top, only the transport-level size caps and
/// correlation the host enforces on its side of the pipe.

// MARK: - Line protocol IO

/// Buffered line reader over a file handle with a hard per-line cap: a request line past 2 MiB is
/// a protocol violation, not a memory event.
private final class LineReader {
    private let handle: FileHandle
    private var buffer = Data()
    private var eof = false
    private static let maxLineBytes = 2 * 1024 * 1024

    init(_ handle: FileHandle) { self.handle = handle }

    /// Next line without its terminator, or nil at EOF.
    func next() -> String? {
        while true {
            if let range = buffer.range(of: Data([0x0A])) {
                let line = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                return String(data: line, encoding: .utf8)
            }
            if eof { return buffer.isEmpty ? nil : drainTail() }
            let chunk = handle.availableData
            if chunk.isEmpty {
                eof = true
                continue
            }
            buffer.append(chunk)
            if buffer.count > Self.maxLineBytes {
                stderrWrite("bridge: request line exceeds \(Self.maxLineBytes) bytes\n")
                return nil // treat as fatal: the host would condemn us anyway
            }
        }
    }

    private func drainTail() -> String? {
        let tail = buffer
        buffer.removeAll()
        return String(data: tail, encoding: .utf8)
    }
}

private func stderrWrite(_ text: String) {
    FileHandle.standardError.write(Data(text.utf8))
}

private func stdoutLine(_ json: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - Entry

guard CommandLine.arguments.contains("--stdio") else {
    stderrWrite("usage: bimax-cu-bridge --stdio\n")
    exit(64)
}

let core = BimaxCuServiceCore()
// `private` because LineReader is a private type; a non-private constant of a private type cannot
// be declared at file scope.
private let reader = LineReader(FileHandle.standardInput)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]

// Sequential by design: the host is single-flight, and an unsolicited stdout line would condemn
// the bridge. Read a request, serve it, reply, repeat until stdin closes.
while let line = reader.next() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }

    // The host always sends an object with a requestId; when even that is unreadable the reply
    // cannot be correlated, and the only honest answer is an empty-id transport error.
    let parsed = (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) as? [String: Any]
    let requestId = (parsed?["requestId"] as? String) ?? ""

    guard let parsed, !parsed.isEmpty else {
        stdoutLine([
            "requestId": requestId,
            "error": ["code": "bridge_malformed_request", "message": "request line is not a JSON object"],
        ])
        continue
    }

    // Hand the raw envelope to the engine as bytes: the engine owns the schema, so the bridge
    // never decodes ops it has no need to understand. Errors here are engine-typed and ride the
    // response envelope, not the transport error path.
    //
    // The original line's bytes are what get handed over. Re-encoding the parsed dictionary was
    // both impossible (`[String: Any]` is not Encodable) and wrong in principle: a re-serialisation
    // round-trip can reorder keys and renormalise numbers, so the engine would validate a document
    // the host never sent. `parsed` is used only to read `requestId` and to reject a non-object.
    let responseData = core.handle(data: Data(trimmed.utf8))

    // Wrap the engine's ResponseEnvelope in the transport frame: the host correlates on the
    // outer requestId first, then validates identity fields inside `response`.
    if let envelope = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any] {
        var frame: [String: Any] = ["requestId": requestId]
        // An engine error is still a well-formed response — the host surfaces it as a typed
        // service error. Only bridge-level failures use the top-level error slot.
        frame["response"] = envelope
        stdoutLine(frame)
    } else {
        stdoutLine([
            "requestId": requestId,
            "error": ["code": "bridge_engine_undecodable", "message": "engine response could not be framed"],
        ])
    }
}

exit(EXIT_SUCCESS)
