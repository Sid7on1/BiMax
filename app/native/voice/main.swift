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

// MARK: - Talk mode
//
//   bimax-voice --talk [--locale …] [--context …] [--silence 900] [--voice <id>] [--input <audio>] [--mute-output]
//
// One warm process for a spoken conversation. It listens after {"cmd":"listen"}, and when the words stop for
// --silence ms it settles them and sends utterance {text}, then stays deaf until told to listen again, so it never
// transcribes its own voice. {"cmd":"speak","text"} queues a sentence; {"cmd":"flush"} marks the end of a reply, and
// "spoken" follows once the queue has been said ("quiet" when it runs dry without a flush). {"cmd":"interrupt"}
// stops speaking at once; {"cmd":"end"} or closing stdin ends the session. --input feeds a file instead of the
// microphone (then silence) and --mute-output speaks at volume 0: together they test a whole turn with no hardware.

func convert(_ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter, _ format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 512
  guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
  var consumed = false
  var error: NSError?
  converter.convert(to: out, error: &error) { _, status in
    if consumed { status.pointee = .noDataNow; return nil }
    consumed = true
    status.pointee = .haveData
    return buffer
  }
  return error == nil && out.frameLength > 0 ? out : nil
}

/// The best installed voice for the language: Premium, then Enhanced, then the Mac's own default voice for it.
func bestVoice(for locale: Locale) -> AVSpeechSynthesisVoice? {
  if let id = argument("--voice"), let voice = AVSpeechSynthesisVoice(identifier: id) { return voice }
  let language = locale.identifier(.bcp47)
  let family = String(language.prefix(2))
  let better = AVSpeechSynthesisVoice.speechVoices()
    .filter { $0.language.hasPrefix(family) && $0.quality.rawValue >= AVSpeechSynthesisVoiceQuality.enhanced.rawValue }
    .sorted { ($0.quality.rawValue, $0.language == language ? 1 : 0) > ($1.quality.rawValue, $1.language == language ? 1 : 0) }
  return better.first ?? AVSpeechSynthesisVoice(language: language) ?? AVSpeechSynthesisVoice(language: "en-US")
}

final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ next: Bool) { lock.lock(); value = next; lock.unlock() }
}

@available(macOS 26.0, *)
final class TalkLoop: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  let listeningNow = Flag()
  /// Audio keeps reaching the analyzer while listening AND while the last words settle: finalize waits for audio
  /// after them. Stopping the feed the moment the words stopped left about 1 turn in 6 never ending (finalizing
  /// through an explicit time: 20 in 20); keeping it flowing, 0 in 30.
  let feedingNow = Flag()
  private let control = DispatchQueue(label: "bimax.voice.talk")
  private let synthesizer = AVSpeechSynthesizer()
  private let analyzer: SpeechAnalyzer
  private let voice: AVSpeechSynthesisVoice?
  private let muted: Bool
  private let silence: TimeInterval
  // Everything below is touched only on `control`.
  private var listening = false
  private var ending = false
  private var finals = ""
  private var partial = ""
  private var lastHeard = Date.distantPast
  private var queue: [String] = []
  private var current: AVSpeechUtterance?
  private var flushed = false

  init(analyzer: SpeechAnalyzer, voice: AVSpeechSynthesisVoice?, muted: Bool, silence: TimeInterval) {
    self.analyzer = analyzer
    self.voice = voice
    self.muted = muted
    self.silence = silence
    super.init()
    synthesizer.delegate = self
  }

  private func setListening(_ on: Bool) { listening = on; listeningNow.set(on); if on { feedingNow.set(true) } }

  func heard(_ text: String, final: Bool) {
    control.async {
      guard self.listening || self.ending else { return }
      if final { self.finals += text; self.partial = "" } else { self.partial = text }
      self.lastHeard = Date()
      if self.listening { Out.send(["event": "partial", "text": (self.finals + self.partial).trimmingCharacters(in: .whitespaces)]) }
    }
  }

  /// Every 100 ms: have the words stopped for long enough to be a finished turn?
  func tick() {
    control.async {
      guard self.listening, !self.ending else { return }
      let text = (self.finals + self.partial).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty, Date().timeIntervalSince(self.lastHeard) >= self.silence else { return }
      self.ending = true
      self.setListening(false)
      Task {
        try? await self.analyzer.finalize(through: nil)
        try? await Task.sleep(nanoseconds: 120_000_000)
        self.control.async {
          let said = (self.finals + self.partial).trimmingCharacters(in: .whitespacesAndNewlines)
          self.finals = ""
          self.partial = ""
          self.ending = false
          if said.isEmpty { self.setListening(true) } else { self.feedingNow.set(false); Out.send(["event": "utterance", "text": said]) }
        }
      }
    }
  }

  func command(_ json: [String: Any]) {
    control.async {
      switch json["cmd"] as? String {
      case "listen":
        self.finals = ""
        self.partial = ""
        self.lastHeard = Date()
        self.setListening(true)
        Out.send(["event": "listening"])
      case "mute":
        self.setListening(false)
        self.feedingNow.set(false)
      case "speak":
        if let text = json["text"] as? String, !text.isEmpty { self.queue.append(text); self.flushed = false; self.next() }
      case "flush":
        if self.current == nil && self.queue.isEmpty { Out.send(["event": "spoken"]) } else { self.flushed = true }
      case "interrupt":
        self.queue.removeAll()
        self.flushed = false
        if self.current != nil {
          self.current = nil
          DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate) }
        }
        Out.send(["event": "interrupted"])
      default:
        break
      }
    }
  }

  private func next() {
    guard current == nil, !queue.isEmpty else { return }
    let text = queue.removeFirst()
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    if muted { utterance.volume = 0 }
    current = utterance
    Out.send(["event": "speaking", "text": text])
    DispatchQueue.main.async { self.synthesizer.speak(utterance) }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    control.async {
      guard self.current === utterance else { return }
      self.current = nil
      if !self.queue.isEmpty { self.next(); return }
      if self.flushed { self.flushed = false; Out.send(["event": "spoken"]) } else { Out.send(["event": "quiet"]) }
    }
  }
}

@available(macOS 26.0, *)
func feedFile(_ path: String, _ format: AVAudioFormat, _ loop: TalkLoop, _ feed: AsyncStream<AnalyzerInput>.Continuation) async {
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
        let converter = AVAudioConverter(from: file.processingFormat, to: format) else {
    Out.fail("file", "Couldn’t read \(path).")
  }
  while !loop.listeningNow.get() { try? await Task.sleep(nanoseconds: 20_000_000) }
  let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
  while let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) {
    do { try file.read(into: buffer, frameCount: chunk) } catch { break }
    if buffer.frameLength == 0 { break }
    if let converted = convert(buffer, converter, format) { feed.yield(AnalyzerInput(buffer: converted)) }
    try? await Task.sleep(nanoseconds: 100_000_000)
  }
  // Then silence, as a person pauses after speaking.
  let frames = AVAudioFrameCount(format.sampleRate / 10)
  for _ in 0..<50 where loop.feedingNow.get() {
    if let quiet = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) {
      quiet.frameLength = frames
      let count = Int(frames) * Int(format.channelCount)
      if let data = quiet.int16ChannelData { data[0].update(repeating: 0, count: count) }
      else if let data = quiet.floatChannelData { data[0].update(repeating: 0, count: count) }
      feed.yield(AnalyzerInput(buffer: quiet))
    }
    try? await Task.sleep(nanoseconds: 100_000_000)
  }
}

@available(macOS 26.0, *)
func talk() async {
  let fileInput = argument("--input")
  if fileInput == nil {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: break
    case .notDetermined:
      if !(await AVCaptureDevice.requestAccess(for: .audio)) { Out.fail("microphone-denied", "Microphone access is off for Bimax.") }
    default:
      Out.fail("microphone-denied", "Microphone access is off for Bimax.")
    }
  }
  let transcriber = await prepareTranscriber()
  let locale = await chooseLocale() ?? Locale(identifier: "en-US")
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  await applyContext(analyzer)
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    Out.fail("audio-format", "No audio format the speech model accepts.")
  }
  let (inputs, feed) = AsyncStream<AnalyzerInput>.makeStream()
  do { try await analyzer.start(inputSequence: inputs) } catch { Out.fail("start", error.localizedDescription) }
  let voice = bestVoice(for: locale)
  let silence = (Double(argument("--silence") ?? "") ?? 900) / 1000
  let loop = TalkLoop(analyzer: analyzer, voice: voice, muted: CommandLine.arguments.contains("--mute-output"), silence: silence)
  let results = Task {
    do { for try await result in transcriber.results { loop.heard(String(result.text.characters), final: result.isFinal) } }
    catch { Out.send(["event": "error", "code": "transcription", "message": error.localizedDescription]) }
  }

  var engine: AVAudioEngine?
  if let path = fileInput {
    Task.detached { await feedFile(path, format, loop, feed) }
  } else {
    let mic = AVAudioEngine()
    let node = mic.inputNode
    let micFormat = node.outputFormat(forBus: 0)
    guard micFormat.sampleRate > 0, let converter = AVAudioConverter(from: micFormat, to: format) else {
      Out.fail("no-microphone", "No microphone is available.")
    }
    var lastLevel = Date.distantPast
    node.installTap(onBus: 0, bufferSize: 2048, format: micFormat) { buffer, _ in
      guard loop.feedingNow.get() else { return }
      if loop.listeningNow.get(), let samples = buffer.floatChannelData?[0], buffer.frameLength > 0, Date().timeIntervalSince(lastLevel) > 0.08 {
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        lastLevel = Date()
        Out.send(["event": "level", "value": min(1, Double(sqrt(sum / Float(buffer.frameLength))) * 12)])
      }
      if let converted = convert(buffer, converter, format) { feed.yield(AnalyzerInput(buffer: converted)) }
    }
    mic.prepare()
    do { try mic.start() } catch { Out.fail("microphone", "Couldn’t start the microphone: \(error.localizedDescription)") }
    engine = mic
  }

  let ticker = DispatchSource.makeTimerSource(queue: .global())
  ticker.schedule(deadline: .now() + 0.1, repeating: 0.1)
  ticker.setEventHandler { loop.tick() }
  ticker.resume()
  let quality = voice.map { ["", "default", "enhanced", "premium"][min(3, max(1, $0.quality.rawValue))] } ?? "default"
  Out.send(["event": "ready", "voice": voice?.name ?? "", "quality": quality, "locale": locale.identifier(.bcp47)])

  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    Thread.detachNewThread {
      while let line = readLine() {
        guard let data = line.data(using: .utf8), let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        if json["cmd"] as? String == "end" { break }
        loop.command(json)
      }
      done.resume()
    }
  }
  ticker.cancel()
  engine?.inputNode.removeTap(onBus: 0)
  engine?.stop()
  feed.finish()
  await analyzer.cancelAndFinishNow()
  results.cancel()
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
    if CommandLine.arguments.contains("--talk") { await talk(); exit(0) }
    Out.fail("usage", "usage: bimax-voice --check | --listen | --talk | --file <audio> [--locale <ids>] [--context <words>]")
  }
}
