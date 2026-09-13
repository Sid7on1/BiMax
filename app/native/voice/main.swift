// bimax-voice: on-device dictation for Bimax, using Apple's SpeechAnalyzer with its dictation model (macOS 26).
// Audio never leaves the Mac.
//
//   bimax-voice --check [--locale en-IN,en-US]                  is dictation available here, and in which language
//   bimax-voice --listen [--locale …] [--context Bimax,Desktop] transcribe the microphone until stdin says stop/cancel or closes
//   bimax-voice --file <audio> [--locale …] [--context …]       transcribe a file (tests and diagnostics)
//
// Output is one JSON object per line: ready, partial {text}, final {text}, level {value}, stopped, error {code, message}.
// A partial is the words still being heard, replaced by the next partial; a final is settled text that will not change.
// --context names words to expect: without it the model hears "Bimax" as "Vmax" or "Baymax".
import AVFoundation
import Foundation
import Speech

enum Out {
  static let lock = NSLock()
  static func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    lock.lock(); defer { lock.unlock() }
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
  }
  static func fail(_ code: String, _ message: String) -> Never {
    send(["event": "error", "code": code, "message": message])
    exit(1)
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func list(_ name: String) -> [String] {
  (argument(name) ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

/// The first requested language the dictation model supports, then the Mac's own, then US English.
@available(macOS 26.0, *)
func chooseLocale() async -> Locale? {
  let candidates = list("--locale").map { Locale(identifier: $0) } + [Locale.current, Locale(identifier: "en-US")]
  for candidate in candidates {
    if let locale = await DictationTranscriber.supportedLocale(equivalentTo: candidate) { return locale }
  }
  return nil
}

@available(macOS 26.0, *)
func prepareTranscriber() async -> DictationTranscriber {
  guard let locale = await chooseLocale() else {
    Out.fail("unsupported-language", "Dictation doesn’t support your language on this Mac.")
  }
  let transcriber = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults], attributeOptions: [])
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      Out.send(["event": "downloading", "locale": locale.identifier(.bcp47)])
      try await request.downloadAndInstall()
    }
  } catch {
    Out.fail("model-unavailable", "Couldn’t get the speech model for \(locale.identifier(.bcp47)): \(error.localizedDescription)")
  }
  return transcriber
}

@available(macOS 26.0, *)
func applyContext(_ analyzer: SpeechAnalyzer) async {
  let words = list("--context")
  guard !words.isEmpty else { return }
  let context = AnalysisContext()
  context.contextualStrings[.general] = words
  do { try await analyzer.setContext(context) } catch { Out.send(["event": "note", "message": "context ignored: \(error.localizedDescription)"]) }
}

@available(macOS 26.0, *)
func forward(_ transcriber: DictationTranscriber) -> Task<Void, Never> {
  Task {
    do {
      for try await result in transcriber.results {
        Out.send(["event": result.isFinal ? "final" : "partial", "text": String(result.text.characters)])
      }
    } catch {
      Out.send(["event": "error", "code": "transcription", "message": error.localizedDescription])
    }
  }
}

@available(macOS 26.0, *)
func check() async {
  guard let locale = await chooseLocale() else {
    Out.send(["event": "check", "supported": false])
    return
  }
  let installed = await DictationTranscriber.installedLocales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
  Out.send(["event": "check", "supported": true, "locale": locale.identifier(.bcp47), "installed": installed,
            "microphone": ["notDetermined", "restricted", "denied", "authorized"][AVCaptureDevice.authorizationStatus(for: .audio).rawValue]])
}

@available(macOS 26.0, *)
func transcribeFile(_ path: String) async {
  let transcriber = await prepareTranscriber()
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  await applyContext(analyzer)
  let results = forward(transcriber)
  do {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    Out.send(["event": "ready"])
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
  } catch {
    Out.fail("file", "Couldn’t transcribe \(path): \(error.localizedDescription)")
  }
  await results.value
  Out.send(["event": "stopped"])
}

@available(macOS 26.0, *)
func listen() async {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: break
  case .notDetermined:
    if !(await AVCaptureDevice.requestAccess(for: .audio)) { Out.fail("microphone-denied", "Microphone access is off for Bimax.") }
  default:
    Out.fail("microphone-denied", "Microphone access is off for Bimax.")
  }
  let transcriber = await prepareTranscriber()
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  await applyContext(analyzer)
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    Out.fail("audio-format", "No audio format the speech model accepts.")
  }
  let (inputs, feed) = AsyncStream<AnalyzerInput>.makeStream()
  let results = forward(transcriber)
  do { try await analyzer.start(inputSequence: inputs) } catch { Out.fail("start", error.localizedDescription) }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  let micFormat = node.outputFormat(forBus: 0)
  guard micFormat.sampleRate > 0, let converter = AVAudioConverter(from: micFormat, to: format) else {
    Out.fail("no-microphone", "No microphone is available.")
  }
  var lastLevel = Date.distantPast
  node.installTap(onBus: 0, bufferSize: 2048, format: micFormat) { buffer, _ in
    if let samples = buffer.floatChannelData?[0], buffer.frameLength > 0, Date().timeIntervalSince(lastLevel) > 0.08 {
      var sum: Float = 0
      for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
      lastLevel = Date()
      Out.send(["event": "level", "value": min(1, Double(sqrt(sum / Float(buffer.frameLength))) * 12)])
    }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / micFormat.sampleRate) + 512
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var consumed = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if consumed { status.pointee = .noDataNow; return nil }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, converted.frameLength > 0 { feed.yield(AnalyzerInput(buffer: converted)) }
  }
  engine.prepare()
  do { try engine.start() } catch { Out.fail("microphone", "Couldn’t start the microphone: \(error.localizedDescription)") }
  Out.send(["event": "ready"])

  // "stop" (or stdin closing, or five minutes) settles the last words; "cancel" drops them.
  let command: String = await withCheckedContinuation { continuation in
    let once = NSLock()
    var resumed = false
    func finish(_ value: String) { once.lock(); defer { once.unlock() }; if !resumed { resumed = true; continuation.resume(returning: value) } }
    Thread.detachNewThread {
      while let line = readLine() {
        let c = line.trimmingCharacters(in: .whitespaces)
        if c == "stop" || c == "cancel" { finish(c); return }
      }
      finish("stop")
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 300) { finish("stop") }
  }
  node.removeTap(onBus: 0)
  engine.stop()
  feed.finish()
  if command == "cancel" {
    await analyzer.cancelAndFinishNow()
    Out.send(["event": "stopped", "cancelled": true])
    exit(0)
  }
  do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { Out.send(["event": "error", "code": "finalize", "message": error.localizedDescription]) }
  await results.value
  Out.send(["event": "stopped"])
}

@main
struct BimaxVoice {
  static func main() async {
    guard #available(macOS 26.0, *) else {
      Out.send(["event": "check", "supported": false, "reason": "Dictation needs macOS 26 or later."])
      exit(0)
    }
    if CommandLine.arguments.contains("--check") { await check(); exit(0) }
    if let path = argument("--file") { await transcribeFile(path); exit(0) }
    if CommandLine.arguments.contains("--listen") { await listen(); exit(0) }
    Out.fail("usage", "usage: bimax-voice --check | --listen | --file <audio> [--locale <ids>] [--context <words>]")
  }
}
