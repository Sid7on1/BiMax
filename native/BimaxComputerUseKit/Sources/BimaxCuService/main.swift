import Foundation
import BimaxCuProtocol
import BimaxComputerUseKit
// ForegroundActivationHelper lives in its own module again, so `--request-front-process` needs the
// import that was implicit while its sources sat inside the kit.
import BimaxFocusBridge

if let index = CommandLine.arguments.firstIndex(of: "--request-front-process") {
    guard CommandLine.arguments.count > index + 2,
          let pid = Int32(CommandLine.arguments[index + 1]) else {
        FileHandle.standardError.write(Data("usage: --request-front-process <pid> <bundle-id>\n".utf8))
        exit(64)
    }
    let yieldPid: Int32? = CommandLine.arguments.count > index + 4
        && CommandLine.arguments[index + 3] == "--yield-pid"
        ? Int32(CommandLine.arguments[index + 4])
        : nil
    let result = ForegroundActivationHelper.request(
        pid: pid, expectedBundleId: CommandLine.arguments[index + 2], yieldPid: yieldPid
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(result.accepted && result.exactPidObserved ? EXIT_SUCCESS : EXIT_FAILURE)
}

if CommandLine.arguments.contains("--self-test-handshake") {
    let response = BimaxCuServiceCore().handshakeResponse()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(response))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(EXIT_SUCCESS)
}

if CommandLine.arguments.contains("--self-test-workspace") {
    let core = BimaxCuServiceCore()
    let created = core.handle(RequestEnvelope(
        requestId: "self-test-create",
        sessionId: "bootstrap",
        deadlineMs: 2_000,
        body: .sessionCreate(requestedId: "self-test")
    ))
    guard case .session(let session) = created.body else {
        FileHandle.standardError.write(Data("failed to create self-test session\n".utf8))
        exit(EXIT_FAILURE)
    }
    let response = core.handle(RequestEnvelope(
        requestId: "self-test-workspace",
        sessionId: session.sessionId,
        deadlineMs: 2_000,
        body: .workspaceSnapshot(.init())
    ))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(response))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(response.error == nil ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-app-workspace") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "ai.bimax.cu.fixture"
    let report = AppWorkspaceConformance.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    // A skipped run is not a pass. A failed *capability* check is not automatically a failure —
    // an operation the platform refuses is reported unverified and simply stops being claimed.
    // A failed invariant, or claiming an operation this run could not reproduce, is.
    let invariantsHeld = report.checks.allSatisfy { check in
        !AppWorkspaceConformanceInvariants.names.contains(check.name) || check.passed
    }
    exit(report.status == "ran" && report.overclaimed.isEmpty && invariantsHeld
        ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-text-scroll") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "com.apple.TextEdit"
    let report = LiveTextScrollSmoke.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    // A skipped run is not a pass. Only an actual run exits zero.
    exit(report.status == "ran" ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-latency") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "com.apple.TextEdit"
    let iterations = CommandLine.arguments.count > index + 2
        ? Int(CommandLine.arguments[index + 2]) ?? 20
        : 20
    let report = LatencyBenchmark.run(bundleId: bundleId, iterations: iterations)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(report.status == "ran" && report.withinBudget ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-catalog") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "ai.bimax.cu.fixture"
    let report = CatalogConformance.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    // A skipped run is not a pass, and neither is one that could not reproduce what the handshake
    // already claims — which is how a run where nothing was observable fails instead of quietly
    // reporting a page of skips.
    let fixtureLabelsHeld = bundleId != "ai.bimax.cu.fixture"
        || report.titleUIElementLabelsVerified == true
    exit(report.status == "ran" && report.overclaimed.isEmpty && !report.transactionsOverclaimed
        && fixtureLabelsHeld
        ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-focus") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "ai.bimax.cu.fixture"
    let report = FocusLeaseConformance.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    // A skipped run is not a pass. A failed check is not automatically a failure — a policy the
    // platform refuses is reported unverified and simply stops being claimed. Claiming a policy
    // this run could not verify is the failure this harness exists to catch.
    exit(report.status == "ran" && report.overclaimed.isEmpty ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-capture") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "ai.bimax.cu.fixture"
    let report = CaptureConformance.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(report.status == "ran" && (report.completeFrames > 0 || report.oneShotFallback)
        ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-stop") {
    let bundleId = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "ai.bimax.cu.fixture"
    let report = StopConformance.run(bundleId: bundleId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(report.status == "ran"
        && report.refusalCode == "foreground_approval_required"
        && report.targetUnchanged && report.foregroundPreserved
        ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-m02") {
    guard CommandLine.arguments.count > index + 4 else {
        FileHandle.standardError.write(Data(
            "usage: --self-test-m02 <target-bundle-id> <bystander-bundle-id> <reminder-state> <typing-state>\n".utf8
        ))
        exit(64)
    }
    let report = M02Conformance.run(
        targetBundleId: CommandLine.arguments[index + 1],
        bystanderBundleId: CommandLine.arguments[index + 2],
        reminderStatePath: CommandLine.arguments[index + 3],
        typingStatePath: CommandLine.arguments[index + 4]
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(report.status == "ran" && report.failed == 0 ? EXIT_SUCCESS : EXIT_FAILURE)
}

if let index = CommandLine.arguments.firstIndex(of: "--self-test-real-app-matrix") {
    let limit = CommandLine.arguments.count > index + 1
        ? Int(CommandLine.arguments[index + 1]) ?? 12 : 12
    let minimum = CommandLine.arguments.count > index + 2
        ? Int(CommandLine.arguments[index + 2]) ?? 4 : 4
    let launchStandard = CommandLine.arguments.contains("--launch-standard-apps")
    let report = RealAppMatrixConformance.run(
        limit: limit, minimumPassing: minimum, launchStandardApps: launchStandard
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(report.status == "ran" && report.foregroundPreserved ? EXIT_SUCCESS : EXIT_FAILURE)
}

let service = BimaxCuXPCService()
let delegate = BimaxCuXPCServiceDelegate(exportedObject: service)
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
