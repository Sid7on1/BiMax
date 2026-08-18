"use strict";
const electron = require("electron");
const path = require("node:path");
const os = require("node:os");
const node_fs = require("node:fs");
const node_child_process = require("node:child_process");
const node_readline = require("node:readline");
const node_crypto = require("node:crypto");
const node_http = require("node:http");
const nodePty = require("@lydell/node-pty");
const path$1 = require("path");
const fs = require("fs");
const os$1 = require("os");
const promises = require("node:fs/promises");
const node_util = require("node:util");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path$1);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os$1);
function cleanLabel(value, max = 80) {
  return value.replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function cleanHost(value) {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes("/") || host.includes("@")) return null;
  if (!/^[a-z0-9:[\]._-]+$/.test(host)) return null;
  return host;
}
class ProcessProvenanceTracker {
  constructor(options = {}) {
    this.options = options;
  }
  records = /* @__PURE__ */ new Map();
  order = [];
  begin(input) {
    const now = this.options.now?.() ?? Date.now();
    const launchId = `launch_${this.options.id?.() ?? node_crypto.randomUUID()}`;
    const record = {
      launchId,
      pid: Number.isInteger(input.pid) && (input.pid ?? 0) > 0 ? input.pid : null,
      parentLaunchId: input.parentLaunchId ?? null,
      executable: {
        basename: cleanLabel(input.executableBasename, 128),
        digest: input.executableDigest?.startsWith("sha256:") ? input.executableDigest : null,
        signer: input.signer ? cleanLabel(input.signer, 160) : null
      },
      cwdClass: input.cwdClass,
      argumentClasses: [...new Set(input.argumentClasses.map((v) => cleanLabel(v)).filter(Boolean))].slice(0, 24),
      startedAt: now,
      endedAt: null,
      outcome: "running",
      exitCode: null,
      signal: null,
      endpoints: [],
      completeness: "complete"
    };
    this.records.set(launchId, record);
    this.order.push(launchId);
    this.evict();
    return launchId;
  }
  endpoint(launchId, input) {
    const record = this.records.get(launchId);
    const host = cleanHost(input.host);
    if (!record || record.outcome !== "running" || !host) return false;
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return false;
    record.endpoints.push({ ...input, host, observedAt: this.options.now?.() ?? Date.now() });
    if (record.endpoints.length > 128) {
      record.endpoints.splice(0, record.endpoints.length - 128);
      record.completeness = "partial";
    }
    return true;
  }
  markGap(launchId) {
    const record = this.records.get(launchId);
    if (!record) return false;
    record.completeness = "gap";
    return true;
  }
  finish(launchId, result) {
    const record = this.records.get(launchId);
    if (!record || record.outcome !== "running") return false;
    record.endedAt = this.options.now?.() ?? Date.now();
    record.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
    record.signal = result.signal ? cleanLabel(result.signal, 40) : null;
    record.outcome = result.spawnError ? "spawn-error" : record.signal ? "signalled" : "exited";
    return true;
  }
  snapshot() {
    return this.order.flatMap((id) => {
      const record = this.records.get(id);
      return record ? [{ ...record, executable: { ...record.executable }, argumentClasses: [...record.argumentClasses], endpoints: record.endpoints.map((e) => ({ ...e })) }] : [];
    });
  }
  /** A privacy-safe identity for diagnostics; it cannot be reversed into arguments or paths. */
  digest() {
    const safe = this.snapshot().map(({ pid: _pid, ...record }) => record);
    return `sha256:${node_crypto.createHash("sha256").update(JSON.stringify(safe)).digest("hex")}`;
  }
  evict() {
    const capacity = Math.max(8, Math.min(1e4, this.options.capacity ?? 512));
    while (this.order.length > capacity) {
      const id = this.order.shift();
      if (id) this.records.delete(id);
    }
  }
}
const MAC_PROVIDER_SERVER_NAME = "bimax-mac";
const OVERRIDE_ENV = {
  engine: "BIMAX_ENGINE_CMD",
  macCapability: "BIMAX_MAC_CAPABILITY_PROVIDER",
  cuService: "BIMAX_CU_SERVICE_BINARY",
  cuBridge: "BIMAX_CU_BRIDGE_BINARY",
  desktopHelper: "BIMAX_DESKTOP_HELPER"
};
const NATIVE_COMPONENT_ENV = [
  OVERRIDE_ENV.cuService,
  OVERRIDE_ENV.cuBridge,
  OVERRIDE_ENV.desktopHelper
];
const HOST_CAPABILITIES_ENV = "BIMAX_HOST_CAPABILITIES_JSON";
class PackagedRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackagedRuntimeError";
  }
}
class EngineArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineArtifactError";
  }
}
function bundlePath(layout, component) {
  const contents = path.resolve(layout.resourcesPath, "..");
  switch (component) {
    case "cuService":
      return path.join(contents, "XPCServices", "BimaxCuService.xpc", "Contents", "MacOS", "bimax-cu-service");
    case "cuBridge":
      return path.join(contents, "MacOS", "bimax-cu-bridge");
    case "desktopHelper":
      return path.join(contents, "MacOS", "bimax-desktop-helper");
    case "macCapability":
      return path.join(contents, "MacOS", "bimax-mac-capability");
  }
}
function devPath(layout, component) {
  const staged = path.join(layout.devRepoRoot, "app", "native-service");
  switch (component) {
    case "cuService":
      return path.join(staged, "BimaxCuService.xpc", "Contents", "MacOS", "bimax-cu-service");
    case "cuBridge":
      return path.join(staged, "bimax-cu-bridge");
    case "desktopHelper":
      return path.join(staged, "bimax-desktop-helper");
    case "macCapability":
      return path.join(staged, "bimax-mac-capability");
  }
}
function packagedEnginePath(layout) {
  return path.join(layout.resourcesPath, "engine", "bimax-engine");
}
function stagedEnginePath(layout) {
  return path.join(layout.devRepoRoot, "app", "engine", "bimax-engine");
}
function resolveNativeComponent(layout, component) {
  const variable = OVERRIDE_ENV[component];
  const override = layout.env[variable]?.trim();
  if (layout.packaged) {
    const bundled = bundlePath(layout, component);
    const resolution = layout.exists(bundled) ? { path: bundled, source: "bundle" } : { source: "missing" };
    if (override) resolution.refusedOverride = { variable, value: override };
    return resolution;
  }
  if (override) return { path: override, source: "override" };
  const candidate = devPath(layout, component);
  return layout.exists(candidate) ? { path: candidate, source: "dev" } : { source: "missing" };
}
function resolveEngineCommand(layout, projectDir2) {
  const variable = OVERRIDE_ENV.engine;
  const override = layout.env[variable]?.trim();
  if (layout.packaged) {
    const bundled = packagedEnginePath(layout);
    if (!layout.exists(bundled)) {
      throw new PackagedRuntimeError(
        `packaged Bimax.app is missing its bundled engine at ${bundled}; refusing to fall back to a development engine`
      );
    }
    return {
      cmd: bundled,
      args: [],
      cwd: projectDir2,
      source: "bundle",
      ...override ? { refusedOverride: { variable, value: override } } : {}
    };
  }
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1), cwd: projectDir2, source: "override" };
  }
  const staged = stagedEnginePath(layout);
  if (!layout.exists(staged)) {
    throw new EngineArtifactError(
      `Desktop engine artifact is not staged at ${staged}; run npm --prefix app run prepare:engine or set BIMAX_ENGINE_CMD explicitly`
    );
  }
  return { cmd: staged, args: [], cwd: projectDir2, source: "artifact" };
}
function describeRefusal(refusal) {
  return `[desktop] ignored ${refusal.variable} in a packaged build (packaged runs resolve from the app bundle only); requested: ${refusal.value}`;
}
function buildEngineChildEnv(input) {
  const env = {
    ...input.parentEnv,
    ...input.extraEnv,
    PATH: input.path,
    BIMAX_HEADLESS: "1",
    BIMAX_CWD: input.projectDir
  };
  delete env.BIMAX_DESKTOP_RELEASE_MODE;
  for (const variable of NATIVE_COMPONENT_ENV) delete env[variable];
  delete env[HOST_CAPABILITIES_ENV];
  if (input.resolved.macCapability) {
    const providerEnv = {
      BIMAX_CWD: input.projectDir,
      BIMAX_HOST_ARCH: input.architecture || (process.arch === "arm64" ? "arm64" : "x64"),
      BIMAX_MAC_PROVIDER_AUTHORITY: "electron-main",
      BIMAX_MAC_CONSENT_CHANNEL: "engine-governor",
      BIMAX_DESKTOP_RELEASE_MODE: input.packaged ? "packaged" : "development"
    };
    providerEnv.BIMAX_CU_TAKEOVER_REQUIRED = "1";
    if (input.takeover) {
      providerEnv.BIMAX_CU_TAKEOVER_ENDPOINT = input.takeover.endpoint;
      providerEnv.BIMAX_CU_TAKEOVER_TOKEN = input.takeover.token;
    }
    if (input.resolved.cuService) providerEnv[OVERRIDE_ENV.cuService] = input.resolved.cuService;
    if (input.resolved.cuBridge) providerEnv[OVERRIDE_ENV.cuBridge] = input.resolved.cuBridge;
    if (input.resolved.desktopHelper) providerEnv[OVERRIDE_ENV.desktopHelper] = input.resolved.desktopHelper;
    env[HOST_CAPABILITIES_ENV] = JSON.stringify({
      version: 1,
      transport: "stdio",
      servers: [{
        // The engine registers each of this server's tools as `mcp__<name>__<tool>`, so this
        // constant is what the renderer's Mac-lane recognizer matches against. One source of truth.
        name: MAC_PROVIDER_SERVER_NAME,
        command: input.resolved.macCapability,
        args: [],
        env: providerEnv
      }]
    });
  }
  return env;
}
let resolvedPath = null;
function userShellPath() {
  if (resolvedPath) return resolvedPath;
  const parts = new Set((process.env.PATH || "").split(":").filter(Boolean));
  if (process.platform !== "win32") {
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      const out = node_child_process.execFileSync(shell, ["-ilc", 'echo -n "$PATH"'], { encoding: "utf8", timeout: 5e3 });
      out.split(":").filter(Boolean).forEach((p) => parts.add(p));
    } catch {
    }
    const home = os.homedir();
    ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/bin`].forEach((p) => {
      if (node_fs.existsSync(p)) parts.add(p);
    });
  }
  resolvedPath = [...parts].join(":");
  return resolvedPath;
}
let takeoverBrokerCredentials = null;
const processProvenance = new ProcessProvenanceTracker();
function engineProcessProvenance() {
  return processProvenance.snapshot();
}
function setTakeoverBrokerCredentials(value) {
  takeoverBrokerCredentials = value;
}
function devRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}
function runtimeLayout() {
  return {
    packaged: electron.app.isPackaged,
    resourcesPath: process.resourcesPath,
    devRepoRoot: devRepoRoot(),
    env: process.env,
    exists: node_fs.existsSync
  };
}
function nativeComponent(component) {
  return resolveNativeComponent(runtimeLayout(), component);
}
function componentResolutions() {
  const layout = runtimeLayout();
  const native = ["macCapability", "cuService", "cuBridge", "desktopHelper"].map((name) => ({
    name,
    resolution: resolveNativeComponent(layout, name)
  }));
  let engine;
  try {
    const resolved = resolveEngineCommand(layout, layout.devRepoRoot);
    engine = {
      path: resolved.cmd || void 0,
      source: resolved.source,
      ...resolved.refusedOverride ? { refusedOverride: resolved.refusedOverride } : {}
    };
  } catch {
    engine = { source: "missing" };
  }
  return [{ name: "engine", resolution: engine }, ...native];
}
function bimaxCuServiceBinary() {
  return nativeComponent("cuService").path;
}
function bimaxDesktopHelperBinary() {
  return nativeComponent("desktopHelper").path;
}
function resolveCommand(projectDir2) {
  const layout = runtimeLayout();
  const resolved = resolveEngineCommand(layout, projectDir2);
  const refusals = [];
  if (resolved.refusedOverride) refusals.push(describeRefusal(resolved.refusedOverride));
  return { cmd: resolved.cmd, args: resolved.args, cwd: resolved.cwd, refusals };
}
function engineReleaseEnv(command) {
  try {
    const manifest = JSON.parse(node_fs.readFileSync(path.join(path.dirname(command), "manifest.json"), "utf8"));
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const artifact = manifest.artifacts?.find((a) => a.platform === "darwin" && a.arch === arch);
    if (!artifact || node_fs.statSync(command).size !== artifact.sizeBytes) return {};
    return {
      BIMAX_ENGINE_VERSION: String(manifest.engine?.version || "unknown"),
      BIMAX_ENGINE_COMMIT: String(manifest.engine?.buildCommit || "unknown")
    };
  } catch {
    return {};
  }
}
const LOG_RING_MAX = 400;
const logRing = [];
function ringWrite(line) {
  logRing.push(line.length > 500 ? line.slice(0, 500) + "…" : line);
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
}
function recentEngineLog(maxChars = 6e3) {
  return logRing.join("\n").slice(-maxChars);
}
function spawnEngineProcess(projectDir2, extraEnv, cb) {
  const { cmd, args, cwd, refusals } = resolveCommand(projectDir2);
  const startedAt = Date.now();
  const command = `${cmd} ${args.join(" ")}`.trim();
  const logDir = path.join(electron.app.getPath("userData"));
  node_fs.mkdirSync(logDir, { recursive: true });
  const logStream = node_fs.createWriteStream(path.join(logDir, "engine.log"), { flags: "a" });
  const logLine = (line) => {
    ringWrite(line);
    logStream.write(line + "\n");
  };
  logLine(`[desktop] ${(/* @__PURE__ */ new Date()).toISOString()} starting engine for ${projectDir2}: ${command}`);
  const nativeService = nativeComponent("cuService");
  const nativeBridge = nativeComponent("cuBridge");
  const desktopHelper = nativeComponent("desktopHelper");
  const macCapability = nativeComponent("macCapability");
  for (const refusal of [
    ...refusals,
    ...[macCapability, nativeService, nativeBridge, desktopHelper].map((r) => r.refusedOverride).filter((r) => !!r).map(describeRefusal)
  ]) logLine(refusal);
  const nativeServiceBinary = nativeService.path;
  const nativeBridgeBinary = nativeBridge.path;
  const desktopHelperBinary = desktopHelper.path;
  const child = node_child_process.spawn(cmd, args, {
    cwd,
    env: buildEngineChildEnv({
      parentEnv: process.env,
      extraEnv: { ...extraEnv, ...engineReleaseEnv(cmd) },
      packaged: electron.app.isPackaged,
      path: userShellPath(),
      projectDir: projectDir2,
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      ...takeoverBrokerCredentials ? { takeover: takeoverBrokerCredentials } : {},
      resolved: {
        macCapability: macCapability.path,
        cuService: nativeServiceBinary,
        cuBridge: nativeBridgeBinary,
        desktopHelper: desktopHelperBinary
      }
    }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const provenanceLaunchId = processProvenance.begin({
    pid: child.pid,
    executableBasename: path.basename(cmd),
    cwdClass: "project",
    argumentClasses: ["headless-agent-protocol"]
  });
  let stderrBuf = "";
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stderrBuf.indexOf("\n")) !== -1) {
      logLine(stderrBuf.slice(0, nl));
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });
  const rl = node_readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg && typeof msg === "object") cb.onMessage(msg);
      else cb.onMalformed(trimmed);
    } catch {
      logLine(`[app] dropped malformed line (${trimmed.length} chars)`);
      cb.onMalformed(trimmed);
    }
  });
  let settled = false;
  child.on("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    processProvenance.finish(provenanceLaunchId, { exitCode: code, signal });
    if (stderrBuf) logLine(stderrBuf);
    logLine(`[desktop] engine exited after ${Date.now() - startedAt}ms: ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`);
    rl.close();
    logStream.end();
    cb.onExit(code, signal);
  });
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    processProvenance.finish(provenanceLaunchId, { spawnError: true });
    logLine(`[desktop] engine process error after ${Date.now() - startedAt}ms: ${err.message}`);
    rl.close();
    logStream.end();
    cb.onError(err);
  });
  return {
    pid: child.pid,
    command,
    write: (line) => {
      const stdin = child.stdin;
      if (stdin && stdin.writable) stdin.write(line);
    },
    endStdin: () => {
      try {
        child.stdin?.end();
      } catch {
      }
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
      }
    }
  };
}
const MAX_BODY_BYTES$1 = 2 * 1024;
const REASON_MAX = 200;
class UserTakeoverAuthority {
  constructor(now = Date.now) {
    this.now = now;
    this.value = { paused: false, generation: 0, reason: "", actor: "system", changedAtMs: 0 };
  }
  value;
  state() {
    return { ...this.value };
  }
  set(input) {
    const paused = input.paused === true;
    if (paused === this.value.paused) return this.state();
    const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
    this.value = {
      paused,
      generation: this.value.generation + 1,
      reason: paused ? rawReason.slice(0, REASON_MAX) || "You took control" : "",
      actor: input.actor === "system" ? "system" : "user",
      changedAtMs: this.now()
    };
    return this.state();
  }
}
function parseTakeoverRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const request = raw;
  if (typeof request.paused !== "boolean") return null;
  if (request.reason !== void 0 && typeof request.reason !== "string") return null;
  if (request.actor !== void 0 && request.actor !== "user" && request.actor !== "system") return null;
  return { paused: request.paused, reason: request.reason, actor: request.actor };
}
async function startUserTakeoverBroker(authority) {
  const token = node_crypto.randomBytes(32).toString("hex");
  const server = node_http.createServer((request, response) => void handleHttp(request, response, authority, token));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("takeover broker did not bind a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/takeover/state`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
async function handleHttp(request, response, authority, token) {
  response.setHeader("content-type", "application/json");
  if (request.method !== "POST" || request.url !== "/v1/takeover/state") {
    write(response, 404, { ok: false, code: "not_found" });
    request.resume();
    return;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > MAX_BODY_BYTES$1) {
      write(response, 413, { ok: false, code: "request_too_large" });
      request.destroy();
      return;
    }
    chunks.push(data);
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    write(response, 400, { ok: false, code: "invalid_json" });
    return;
  }
  const supplied = raw?.token;
  if (typeof supplied !== "string" || !sameToken(supplied, token)) {
    write(response, 403, { ok: false, code: "invalid_token" });
    return;
  }
  write(response, 200, { ok: true, code: "state", state: authority.state() });
}
function write(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
function sameToken(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && node_crypto.timingSafeEqual(left, right);
}
const MINIMUM_MACOS = "13.0";
const LABELS = {
  engine: "Coding engine",
  macCapability: "Mac capability provider",
  cuService: "Computer Use service (XPC)",
  cuBridge: "Computer Use bridge",
  desktopHelper: "Desktop helper"
};
const COMPUTER_USE_ONLY = {
  engine: false,
  macCapability: true,
  cuService: true,
  cuBridge: true,
  desktopHelper: true
};
function toComponentReport(name, resolution) {
  return {
    name,
    label: LABELS[name],
    present: !!resolution.path,
    ...resolution.path ? { path: resolution.path } : {},
    source: resolution.source,
    ...resolution.refusedOverride ? { refusedOverride: resolution.refusedOverride } : {},
    computerUseOnly: COMPUTER_USE_ONLY[name]
  };
}
function buildTrustReport(input) {
  const components = input.components.map(({ name, resolution }) => ({
    ...toComponentReport(name, resolution),
    ...input.integrity.components[name]
  }));
  const byName = new Map(components.map((c) => [c.name, c]));
  const blockers = [];
  if (input.permissions.accessibility !== "granted") {
    blockers.push("Accessibility permission is not granted");
  }
  if (input.permissions.screenRecording !== "granted") {
    blockers.push("Screen Recording permission is not granted");
  }
  for (const name of ["macCapability", "cuService", "cuBridge", "desktopHelper"]) {
    const component = byName.get(name);
    if (!component?.present) blockers.push(`${LABELS[name]} is not available`);
  }
  if (!input.userTakeover.available) {
    blockers.push(
      input.userTakeover.detail || "Bimax could not set up the control you would use to take over, so it will not act on your Mac"
    );
  }
  if (input.nativeServiceTrust && !input.nativeServiceTrust.ready) {
    blockers.push(
      input.nativeServiceTrust.detail || "The Computer Use service has not been trusted for this build"
    );
  }
  const unknowns = [];
  for (const [key, value] of Object.entries(input.permissions)) {
    if (value === "unavailable") unknowns.push(`${key} permission state could not be read`);
  }
  if (!input.build.packaged) {
    unknowns.push("running unpackaged: build identity and permission ownership are not authoritative");
  }
  if (input.integrity.app.signature.kind === "unknown") unknowns.push("app code signature state could not be established");
  if (input.integrity.app.signature.notarization === "unknown") unknowns.push("app notarization state could not be established");
  const stable = input.build.packaged && input.integrity.app.signature.kind === "developer-id" && input.integrity.app.signature.hardenedRuntime === true && input.integrity.app.signature.gatekeeper === "accepted" && input.integrity.app.signature.notarization === "accepted";
  const qualification = !input.build.packaged ? "development" : stable ? "stable" : "manual-alpha";
  return {
    generatedAt: input.now().toISOString(),
    build: input.build,
    appIntegrity: {
      ...input.integrity.app.sha256 ? { executableSha256: input.integrity.app.sha256 } : {},
      signature: input.integrity.app.signature
    },
    release: {
      qualification,
      warning: qualification === "manual-alpha" ? "Manual alpha: this build is not established as Developer ID signed and notarized. Verify its exact SHA-256 before opening it." : null,
      updatePermissionWarning: "After replacing Bimax.app, macOS may ask you to grant Screen Recording or Accessibility again. Re-check Trust Center before Control Mac work."
    },
    permissions: input.permissions,
    components,
    coding: {
      // Invariant, by product design. Never derive this from `blockers`.
      available: !!byName.get("engine")?.present,
      requiresPermissions: []
    },
    computerUse: { available: blockers.length === 0, blockers },
    unknowns
  };
}
function field(text, name) {
  return text.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
}
function parseSignatureAssessment(codesign, spctl) {
  const signingText = `${codesign.stdout}
${codesign.stderr}`;
  const assessmentText = `${spctl.stdout}
${spctl.stderr}`;
  const authority = field(signingText, "Authority");
  const flags = field(signingText, "CodeDirectory") || signingText;
  let kind = "unknown";
  if (!codesign.ok && /not signed at all|code object is not signed/i.test(signingText)) kind = "unsigned";
  else if (/^Signature=adhoc$/m.test(signingText) || /flags=.*adhoc/i.test(signingText)) kind = "ad-hoc";
  else if (authority?.startsWith("Developer ID Application:")) kind = "developer-id";
  else if (authority?.startsWith("Apple Development:")) kind = "apple-development";
  const gatekeeper = spctl.ok ? "accepted" : /rejected|deny|not accepted/i.test(assessmentText) ? "rejected" : "unknown";
  const notarization = /source=Notarized Developer ID/i.test(assessmentText) ? "accepted" : gatekeeper === "rejected" ? "rejected" : "unknown";
  return {
    kind,
    ...field(signingText, "Identifier") ? { identifier: field(signingText, "Identifier") } : {},
    ...field(signingText, "TeamIdentifier") && field(signingText, "TeamIdentifier") !== "not set" ? { teamIdentifier: field(signingText, "TeamIdentifier") } : {},
    ...authority ? { authority } : {},
    hardenedRuntime: codesign.ok ? /\bruntime\b/i.test(flags) : null,
    gatekeeper,
    notarization
  };
}
function sha256File(file) {
  return node_crypto.createHash("sha256").update(node_fs.readFileSync(file)).digest("hex");
}
function run$1(file, args) {
  try {
    return { ok: true, stdout: node_child_process.execFileSync(file, args, { encoding: "utf8", timeout: 5e3 }), stderr: "" };
  } catch (error) {
    const value = error;
    return {
      ok: false,
      stdout: String(value.stdout || ""),
      stderr: String(value.stderr || (error instanceof Error ? error.message : ""))
    };
  }
}
function inspectExecutable(file, platform = process.platform) {
  let sha256;
  try {
    sha256 = sha256File(file);
  } catch {
  }
  if (platform !== "darwin") {
    return {
      ...sha256 ? { sha256 } : {},
      signature: {
        kind: "unknown",
        hardenedRuntime: null,
        gatekeeper: "unknown",
        notarization: "unknown"
      }
    };
  }
  const codesign = run$1("/usr/bin/codesign", ["--display", "--verbose=4", file]);
  const spctl = run$1("/usr/sbin/spctl", ["--assess", "--verbose=4", "--type", "execute", file]);
  return { ...sha256 ? { sha256 } : {}, signature: parseSignatureAssessment(codesign, spctl) };
}
const DIAGNOSTIC_EXPORT_OMISSIONS = [
  "API keys, tokens, passwords and environment variables",
  "project paths, file contents and source code",
  "conversation and model transcript content",
  "raw engine logs and crash log tails"
];
function buildDiagnosticExport(input) {
  return {
    schemaVersion: 1,
    generatedAt: input.now().toISOString(),
    privacy: {
      localFirst: true,
      destinationChosenByUser: true,
      omitted: [...DIAGNOSTIC_EXPORT_OMISSIONS]
    },
    trust: {
      generatedAt: input.trust.generatedAt,
      build: input.trust.build,
      release: input.trust.release,
      appIntegrity: input.trust.appIntegrity,
      permissions: input.trust.permissions,
      coding: input.trust.coding,
      computerUse: {
        available: input.trust.computerUse.available,
        blockerCount: input.trust.computerUse.blockers.length
      },
      unknowns: input.trust.unknowns,
      components: input.trust.components.map((component) => ({
        name: component.name,
        label: component.label,
        present: component.present,
        source: component.source,
        computerUseOnly: component.computerUseOnly,
        sha256: component.sha256,
        signature: component.signature,
        refusedOverride: !!component.refusedOverride
      }))
    },
    supervisor: input.status ? {
      phase: input.status.phase,
      reason: input.status.reason,
      attempt: input.status.attempt,
      generation: input.status.generation,
      profile: input.status.profile,
      capabilities: input.status.capabilities,
      degradedCapabilities: input.status.degradedCapabilities,
      lastHeartbeat: input.status.lastHeartbeat
    } : null,
    crashes: input.crashes.slice(-10).map((crash) => ({
      at: crash.at,
      kind: crash.kind,
      lastPhase: crash.lastPhase,
      uptimeMs: crash.uptimeMs,
      exitCode: crash.exitCode,
      signal: crash.signal,
      protocol: crash.protocol,
      memory: crash.memory,
      profile: crash.profile,
      capabilities: crash.capabilities,
      attempt: crash.attempt,
      interruptedWork: crash.interruptedWork,
      recovery: crash.recovery
    }))
  };
}
const EVIDENCE_SCHEMA = "bimax.evidence/1";
function admissible(c) {
  return c.complete && c.droppedEvents === 0;
}
const BASES = /* @__PURE__ */ new Set(["observed", "declared", "mixed"]);
function isBasis(value) {
  return typeof value === "string" && BASES.has(value);
}
const DISPOSITIONS = [
  "observe",
  "explain",
  "recommend",
  "require-approval",
  "isolate",
  "block",
  "repair"
];
function dispositionRank(d) {
  return DISPOSITIONS.indexOf(d);
}
function unreachable(value) {
  throw new Error(`unhandled evidence variant: ${String(value)}`);
}
function dispositionCeiling(layer) {
  switch (layer) {
    case "A":
      return "repair";
    case "B":
      return "block";
    case "C":
      return "require-approval";
    case "D":
      return "recommend";
    case "E":
      return "recommend";
    case "F":
      return "explain";
  }
  return unreachable(layer);
}
const RULE_IDS = {
  // Layer A — invariants. Not overridable by any approval.
  CREDENTIAL_READ: "BMX-A-CREDENTIAL-READ",
  PERSISTENCE_WRITE: "BMX-A-PERSISTENCE-WRITE",
  SECURITY_SETTING_MUTATION: "BMX-A-SECURITY-SETTING",
  SYSTEM_INTEGRITY: "BMX-A-SYSTEM-INTEGRITY",
  PLAN_MODE_WRITE: "BMX-A-PLAN-MODE-WRITE",
  // Layer B — task and capability mismatch.
  WRITE_OUTSIDE_BOUNDARY: "BMX-B-WRITE-OUTSIDE-BOUNDARY",
  READ_OUTSIDE_BOUNDARY: "BMX-B-READ-OUTSIDE-BOUNDARY",
  UNDECLARED_INSTALL: "BMX-B-UNDECLARED-INSTALL",
  UNDECLARED_HOST: "BMX-B-UNDECLARED-HOST",
  MANIFEST_EXCEEDED: "BMX-B-MANIFEST-EXCEEDED",
  RECEIPT_CONTRADICTS_INTENT: "BMX-B-RECEIPT-CONTRADICTS-INTENT",
  // Layer C — known risky macOS behavior.
  LAUNCH_ITEM_CHANGE: "BMX-C-LAUNCH-ITEM",
  SSH_AUTHORIZED_KEYS: "BMX-C-SSH-AUTHORIZED-KEYS",
  BROWSER_CREDENTIAL_STORE: "BMX-C-BROWSER-CREDENTIALS",
  EXECUTABLE_REPLACED: "BMX-C-EXECUTABLE-REPLACED",
  // Layer D/E/F — advisory.
  PROVENANCE_ANOMALY: "BMX-D-PROVENANCE-ANOMALY",
  STATISTICAL_ANOMALY: "BMX-E-STATISTICAL-ANOMALY",
  MODEL_HYPOTHESIS: "BMX-F-MODEL-HYPOTHESIS",
  // Evidence honesty — reported like any other finding so a gap is visible in the timeline.
  EVIDENCE_GAP: "BMX-X-EVIDENCE-GAP"
};
const RULE_ID_SET = new Set(Object.values(RULE_IDS));
function isRuleId(value) {
  return RULE_ID_SET.has(value);
}
function ruleLayer(ruleId) {
  const match = /^BMX-([ABCDEFX])-/.exec(ruleId);
  return match ? match[1] : null;
}
const SECRET_KEY_PATTERNS = [
  /secret/,
  /password/,
  /passwd/,
  /token/,
  /apikey/,
  /credential/,
  /privatekey/,
  /authorization/,
  /cookie/,
  /session(id)?$/,
  /bearer/,
  /passphrase/,
  /keychain/,
  /clipboard/,
  /filecontents?/,
  /^content$/,
  /^body$/,
  /^env$/,
  /^environ(ment)?$/
];
const normalizeKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
function isSecretKey(key) {
  const normalized = normalizeKey(key);
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}
const REDACTED = "[redacted]";
function factsRedacted(facts, depth = 0) {
  if (depth > 8) return true;
  for (const [key, value] of Object.entries(facts)) {
    if (isSecretKey(key) && value !== REDACTED) return false;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!factsRedacted(value, depth + 1)) return false;
    }
  }
  return true;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function canonicalize(value) {
  if (value === null || value === void 0) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === void 0) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return null;
}
const ok = () => ({ ok: true, violations: [] });
const fail = (...violations) => ({ ok: false, violations });
function validate$1(record) {
  if (record.schema !== EVIDENCE_SCHEMA) {
    return fail(`record is not ${EVIDENCE_SCHEMA}`);
  }
  switch (record.kind) {
    case "TaskIntent":
      return validateTaskIntent(record);
    case "OperationIntent":
      return validateOperationIntent(record);
    case "Observation":
      return validateObservation(record);
    case "Decision":
      return validateDecision(record);
    case "Approval":
      return validateApproval(record);
    case "ActionReceipt":
      return validateActionReceipt(record);
    case "Verification":
      return validateVerification(record);
    case "Rollback":
      return validateRollback(record);
    default:
      return fail(`unknown evidence kind ${record.kind}`);
  }
}
function validateTaskIntent(record) {
  const violations = [];
  if (!record.summary.trim()) violations.push("TaskIntent.summary is empty");
  if (record.boundary.allowSecuritySettings === true) {
    violations.push("TaskBoundary.allowSecuritySettings can never be granted");
  }
  if (record.boundary.writeRoots.some((root) => !root.startsWith("/"))) {
    violations.push("TaskBoundary.writeRoots must be absolute normalized paths");
  }
  if (record.boundary.readRoots.some((root) => !root.startsWith("/"))) {
    violations.push("TaskBoundary.readRoots must be absolute normalized paths");
  }
  return violations.length ? fail(...violations) : ok();
}
function validateOperationIntent(record) {
  const violations = [];
  if (!record.taskIntentId) violations.push("OperationIntent must name its TaskIntent");
  if (!record.operation.trim()) violations.push("OperationIntent.operation is empty");
  if (record.parentOperationId === record.id) violations.push("OperationIntent is its own parent");
  const declared = record.declared;
  if (declared.readOnly && (declared.writes.length || declared.deletes.length || declared.installsDependencies)) {
    violations.push("OperationIntent declares readOnly and mutations at once");
  }
  return violations.length ? fail(...violations) : ok();
}
function validateObservation(record) {
  const violations = [];
  if (record.sensitivity === "secret") {
    violations.push("an Observation may not be classified secret — redact it instead of storing it");
  }
  if (!factsRedacted(record.facts)) {
    violations.push("Observation.facts still contains a secret-bearing key");
  }
  if (record.freshnessMs < 0) violations.push("Observation.freshnessMs is negative");
  if (!record.completeness.complete && !record.completeness.reason) {
    violations.push("an incomplete Observation must state why");
  }
  if (!record.subject.id) violations.push("Observation.subject has no identity");
  return violations.length ? fail(...violations) : ok();
}
function validateDecision(record) {
  const violations = [];
  const ceiling = dispositionCeiling(record.layer);
  if (dispositionRank(record.disposition) > dispositionRank(ceiling)) {
    violations.push(
      `layer ${record.layer} may not reach disposition ${record.disposition} (ceiling ${ceiling})`
    );
  }
  if (!record.ruleVersion) violations.push("Decision.ruleVersion is required");
  if (!isBasis(record.evidenceBasis)) {
    violations.push("Decision.evidenceBasis must say whether this rests on measurement or declaration");
  }
  if (record.modelExplanation && !record.modelVersion) {
    violations.push("a model explanation must name the model version that produced it");
  }
  for (const finding of record.findings) {
    if (!isRuleId(finding.ruleId)) {
      violations.push(`finding cites unregistered rule ${finding.ruleId}`);
      continue;
    }
    const layerOfRule = ruleLayer(finding.ruleId);
    if (layerOfRule && layerOfRule !== "X" && layerOfRule !== finding.layer) {
      violations.push(`finding ${finding.ruleId} claims layer ${finding.layer}`);
    }
    if (!finding.evidence.length) {
      violations.push(`finding ${finding.ruleId} cites no observation — a vacuous finding`);
    }
    if (!finding.subjects.length) {
      violations.push(`finding ${finding.ruleId} names no identity that performed or received it`);
    }
    if (finding.layer !== "A" && !finding.benignExplanations.length) {
      violations.push(`finding ${finding.ruleId} offers no plausible benign explanation`);
    }
  }
  if (dispositionRank(record.disposition) >= dispositionRank("block")) {
    const deterministic = record.findings.some((f) => f.layer === "A" || f.layer === "B" || f.layer === "C");
    if (!deterministic) violations.push("block/repair requires a deterministic Layer A/B/C finding");
    if (!record.findings.length) violations.push("block/repair with no findings");
  }
  if (!admissible(record.factors.observationCompleteness) && record.disposition === "observe") {
    violations.push("a Decision on incomplete evidence may not settle at observe");
  }
  if (record.disposition === "repair" && record.evidenceBasis !== "observed") {
    violations.push(`a repair requires observed evidence; this rests on ${record.evidenceBasis} effects`);
  }
  if (record.factors.anomalyConfidence !== null && (record.factors.anomalyConfidence < 0 || record.factors.anomalyConfidence > 1)) {
    violations.push("anomalyConfidence must be within 0..1");
  }
  return violations.length ? fail(...violations) : ok();
}
function validateApproval(record) {
  const violations = [];
  if (!record.operationIntentId) violations.push("Approval must name the operation it approves");
  if (record.expiresAt !== null && record.expiresAt <= record.createdAt) {
    violations.push("Approval expires at or before it was granted");
  }
  return violations.length ? fail(...violations) : ok();
}
function validateActionReceipt(record) {
  const violations = [];
  if (!record.operationIntentId) violations.push("ActionReceipt must name its OperationIntent");
  if (!record.executor) violations.push("ActionReceipt must name the executor that ran it");
  if (record.outcome === "applied" && !record.after.length) {
    violations.push("an applied ActionReceipt must cite after-state observations");
  }
  if (record.outcome === "rolled-back" && !record.before.length) {
    violations.push("a rolled-back ActionReceipt must cite the before state it returned to");
  }
  return violations.length ? fail(...violations) : ok();
}
function validateVerification(record) {
  const violations = [];
  if (!record.actionReceiptId) violations.push("Verification must name its ActionReceipt");
  if (record.freshnessBudgetMs <= 0) violations.push("Verification.freshnessBudgetMs must be positive");
  const stale = record.freshnessMs > record.freshnessBudgetMs;
  const incomplete = !admissible(record.completeness);
  if (record.satisfied === true && (stale || incomplete)) {
    violations.push(
      "a satisfied Verification requires complete, fresh evidence: " + [
        stale ? `evidence is ${record.freshnessMs}ms old against a ${record.freshnessBudgetMs}ms budget` : "",
        incomplete ? record.completeness.reason || "observation is incomplete" : ""
      ].filter(Boolean).join("; ")
    );
  }
  if (record.satisfied === true && record.basis !== "observed") {
    violations.push(
      `a satisfied Verification requires observed evidence; this rests on ${record.basis} effects`
    );
  }
  if (!isBasis(record.basis)) {
    violations.push("Verification.basis must say whether the postcondition was measured or declared");
  }
  if (record.satisfied !== null && !record.evidence.length) {
    violations.push("a Verification verdict must cite the observations it rests on");
  }
  if (!record.reason.trim()) violations.push("Verification.reason is empty");
  return violations.length ? fail(...violations) : ok();
}
function validateRollback(record) {
  const violations = [];
  if (!record.actionReceiptId) violations.push("Rollback must name its ActionReceipt");
  if (!record.target) violations.push("Rollback must name a restoration target");
  if (record.result === "restored" && !record.verificationId) {
    violations.push("a restored Rollback must cite an independent Verification");
  }
  return violations.length ? fail(...violations) : ok();
}
const RETENTION_MS = {
  none: 0,
  session: 12 * 60 * 60 * 1e3,
  task: 7 * 24 * 60 * 60 * 1e3,
  bounded: 30 * 24 * 60 * 60 * 1e3,
  audit: 180 * 24 * 60 * 60 * 1e3
};
function contentId(record) {
  const { id: _ignored, ...rest } = record;
  return node_crypto.createHash("sha256").update(canonicalJson(rest)).digest("hex").slice(0, 24);
}
class DesktopEvidenceStore {
  records = /* @__PURE__ */ new Map();
  order = [];
  evictions = [];
  maxRecords;
  now;
  constructor(options = {}) {
    this.maxRecords = options.maxRecords ?? 2e4;
    this.now = options.now ?? Date.now;
  }
  /**
   * Admit a record that arrived over IPC.
   *
   * The seal is recomputed rather than trusted: a sender that edits a record after sealing it — or a
   * compromised renderer replaying an altered record back — has changed the content, and the content
   * is what the id is derived from. This is the one place Desktop can catch that.
   */
  ingest(record) {
    const validation = validate$1(record);
    if (!validation.ok) return { accepted: false, violations: validation.violations };
    if (!record.id.endsWith(contentId(record))) {
      return { accepted: false, violations: ["record id does not match its content"] };
    }
    if (this.records.has(record.id)) return { accepted: true, violations: [] };
    this.records.set(record.id, record);
    this.order.push(record.id);
    this.enforceCapacity();
    return { accepted: true, violations: [] };
  }
  /** Admit a batch, reporting each refusal. A bad record never poisons the good ones beside it. */
  ingestAll(records) {
    let accepted = 0;
    const refused = [];
    for (const record of records) {
      const result = this.ingest(record);
      if (result.accepted) accepted += 1;
      else refused.push({ id: record.id, violations: result.violations });
    }
    return { accepted, refused };
  }
  all() {
    return this.order.map((id) => this.records.get(id)).filter(Boolean);
  }
  forTask(taskIntentId) {
    return this.all().filter((record) => "taskIntentId" in record && record.taskIntentId === taskIntentId || record.id === taskIntentId);
  }
  evictionLog() {
    return this.evictions;
  }
  get size() {
    return this.records.size;
  }
  /** Drop expired observations. Returns how many went. */
  applyRetention() {
    const now = this.now();
    const expired = this.all().filter((record) => record.kind === "Observation" && now - record.createdAt > RETENTION_MS[record.retention]);
    return this.drop(expired.map((r) => r.id), "retention");
  }
  /** The Trust Center's per-task delete control. */
  deleteTask(taskIntentId) {
    return this.drop(this.forTask(taskIntentId).map((r) => r.id), "user-deletion");
  }
  /** The Trust Center's "delete every observation" control. */
  deleteObservations() {
    return this.drop(this.all().filter((r) => r.kind === "Observation").map((r) => r.id), "user-deletion");
  }
  /** The Trust Center's "delete everything" control. */
  deleteAll() {
    return this.drop([...this.order], "user-deletion");
  }
  drop(ids, reason) {
    let dropped = 0;
    for (const id of ids) {
      if (!this.records.delete(id)) continue;
      const index = this.order.indexOf(id);
      if (index >= 0) this.order.splice(index, 1);
      dropped += 1;
    }
    if (dropped) this.evictions.push({ at: this.now(), droppedRecords: dropped, reason });
    return dropped;
  }
  enforceCapacity() {
    const excess = this.order.length - this.maxRecords;
    if (excess <= 0) return;
    this.drop(this.order.slice(0, excess), "capacity");
  }
}
function confidenceOf(basis, observations) {
  if (observations.some((o) => !admissible(o.completeness))) return "incomplete";
  return basis === "observed" ? "measured" : "declared";
}
function buildEvidenceTimeline(records, evictions = []) {
  const task = records.find((r) => r.kind === "TaskIntent") ?? null;
  const operations = /* @__PURE__ */ new Map();
  const decisions = /* @__PURE__ */ new Map();
  const observations = /* @__PURE__ */ new Map();
  const receipts = /* @__PURE__ */ new Map();
  const verifications = /* @__PURE__ */ new Map();
  const byKind = {};
  let oldestAt = null;
  let newestAt = null;
  for (const entry of records) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    oldestAt = oldestAt === null ? entry.createdAt : Math.min(oldestAt, entry.createdAt);
    newestAt = newestAt === null ? entry.createdAt : Math.max(newestAt, entry.createdAt);
    switch (entry.kind) {
      case "OperationIntent":
        operations.set(entry.id, entry);
        break;
      case "Decision":
        decisions.set(entry.operationIntentId, [...decisions.get(entry.operationIntentId) ?? [], entry]);
        break;
      case "Observation":
        if (entry.operationIntentId) {
          observations.set(entry.operationIntentId, [...observations.get(entry.operationIntentId) ?? [], entry]);
        }
        break;
      case "ActionReceipt":
        receipts.set(entry.operationIntentId, entry);
        break;
      case "Verification":
        verifications.set(entry.actionReceiptId, entry);
        break;
    }
  }
  const pathOf = (operationId) => {
    const labels = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = operationId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const operation = operations.get(cursor);
      if (!operation) break;
      labels.push(operation.operation);
      cursor = operation.parentOperationId;
    }
    return labels;
  };
  const rows = [...operations.values()].map((operation) => {
    const operationDecisions = decisions.get(operation.id) ?? [];
    const current = operationDecisions[operationDecisions.length - 1] ?? null;
    const operationObservations = observations.get(operation.id) ?? [];
    const receipt = receipts.get(operation.id) ?? null;
    const verification = receipt ? verifications.get(receipt.id) ?? null : null;
    const gapObservation = operationObservations.find((o) => !admissible(o.completeness));
    return {
      operationId: operation.id,
      operation: operation.operation,
      subsystem: operation.subsystem,
      causalPath: pathOf(operation.id),
      disposition: current?.disposition ?? null,
      findings: operationDecisions.flatMap((d) => d.findings),
      confidence: confidenceOf(current?.evidenceBasis ?? "declared", operationObservations),
      modelExplanation: current?.modelExplanation && current.modelVersion ? { version: current.modelVersion, text: current.modelExplanation } : null,
      evidenceGap: gapObservation?.completeness.reason ?? (current && !admissible(current.factors.observationCompleteness) ? current.factors.observationCompleteness.reason ?? "the evidence for this operation is incomplete" : null),
      receipt: receipt ? { executor: receipt.executor, outcome: receipt.outcome, reason: receipt.reason } : null,
      verification: verification ? { postcondition: verification.postcondition, satisfied: verification.satisfied, reason: verification.reason } : null
    };
  });
  return {
    task: task ? { id: task.id, summary: task.summary, projectRoot: task.projectRoot } : null,
    rows,
    retention: { totalRecords: records.length, byKind, evictions, oldestAt, newestAt },
    hasEvidenceGap: rows.some((row) => row.evidenceGap !== null) || evictions.length > 0
  };
}
function retentionControls(records, taskIntentId) {
  const forTask = taskIntentId ? records.filter((r) => "taskIntentId" in r && r.taskIntentId === taskIntentId || r.id === taskIntentId) : [];
  const observations = records.filter((r) => r.kind === "Observation");
  return [
    {
      label: "Delete this task's evidence",
      effect: "removes the task intent, its operations, observations, decisions and receipts; findings already shown are gone",
      affectedRecords: forTask.length
    },
    {
      label: "Delete all observations",
      effect: "keeps decisions and receipts but removes the raw observations behind them, so those decisions become unverifiable",
      affectedRecords: observations.length
    },
    {
      label: "Delete everything",
      effect: "clears the whole local evidence store; nothing is retained and no finding can be re-derived",
      affectedRecords: records.length
    }
  ];
}
const BOOT_LADDER = [
  "spawning",
  "booting",
  "loading_storage",
  "loading_graph",
  "loading_tools",
  "restoring_session",
  "ready"
];
const LEGAL = {
  idle: ["spawning"],
  // The engine may legally skip boot phases (an old binary emits none and jumps straight to
  // ready), any live phase can end in exited/failed/stopping, and a launch with shed
  // capabilities lands on `degraded` instead of `ready` — from ANY startup phase.
  spawning: ["booting", "loading_storage", "loading_graph", "loading_tools", "restoring_session", "ready", "degraded", "exited", "failed", "stopping", "restarting"],
  booting: ["loading_storage", "loading_graph", "loading_tools", "restoring_session", "ready", "degraded", "exited", "failed", "stopping", "restarting"],
  loading_storage: ["loading_graph", "loading_tools", "restoring_session", "ready", "degraded", "exited", "failed", "stopping", "restarting"],
  loading_graph: ["loading_tools", "restoring_session", "ready", "degraded", "exited", "failed", "stopping", "restarting"],
  loading_tools: ["restoring_session", "ready", "degraded", "exited", "failed", "stopping", "restarting"],
  restoring_session: ["ready", "degraded", "exited", "failed", "stopping", "restarting"],
  ready: ["degraded", "restarting", "stopping", "exited", "failed"],
  degraded: ["ready", "restarting", "stopping", "exited", "failed"],
  restarting: ["spawning", "failed", "stopping", "idle"],
  stopping: ["exited", "idle", "spawning"],
  exited: ["spawning", "restarting", "idle"],
  failed: ["spawning", "restarting", "idle"]
};
function transition(current, next) {
  if (current === next) return { ok: true, phase: current };
  if (LEGAL[current]?.includes(next)) return { ok: true, phase: next };
  return { ok: false, phase: current };
}
function isStartupPhase(phase) {
  return phase !== "ready" && BOOT_LADDER.includes(phase);
}
function bootProgress(phase) {
  const idx = BOOT_LADDER.indexOf(phase);
  if (idx === -1 || phase === "ready") return void 0;
  return { step: idx + 1, total: BOOT_LADDER.length };
}
function phaseMessage(phase) {
  switch (phase) {
    case "idle":
      return "No engine running";
    case "spawning":
      return "Launching engine process…";
    case "booting":
      return "Engine booting…";
    case "loading_storage":
      return "Loading configuration and storage…";
    case "loading_graph":
      return "Loading code graph…";
    case "loading_tools":
      return "Wiring tools…";
    case "restoring_session":
      return "Restoring sessions…";
    case "ready":
      return "Engine ready";
    case "degraded":
      return "Engine ready (some services disabled)";
    case "restarting":
      return "Restarting engine…";
    case "stopping":
      return "Stopping engine…";
    case "exited":
      return "Engine stopped";
    case "failed":
      return "Engine failed to start";
  }
}
function classifyExit(f) {
  if (f.intentional) return "clean_shutdown";
  if (f.spawnError) return "spawn_error";
  if (f.watchdog) return f.watchdog;
  if (f.signal === "SIGKILL") return "external_kill";
  if (f.signal) return "crash";
  if (f.code === 0) return "clean_shutdown";
  return "crash";
}
const DEFAULT_POLICY = {
  maxAttempts: 5,
  windowMs: 10 * 6e4,
  baseDelayMs: 1e3,
  maxDelayMs: 3e4,
  jitterRatio: 0.25,
  stableMs: 12e4
};
function consecutiveCrashes(history, now, cfg) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i];
    if (c.kind === "clean_shutdown") break;
    if (now - c.at > cfg.windowMs) break;
    n++;
    if (c.uptimeMs >= cfg.stableMs) break;
  }
  return n;
}
function shedProfile(current, history, now, cfg) {
  let resourceCrashes = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i];
    if (c.kind === "clean_shutdown" || now - c.at > cfg.windowMs) break;
    if (c.kind === "external_kill" || c.kind === "unresponsive") resourceCrashes++;
  }
  if (resourceCrashes >= 2) return "minimal";
  if (resourceCrashes >= 1) return current === "minimal" ? "minimal" : "conservative";
  return current;
}
function decideRestart(history, now, currentProfile, cfg, random) {
  const last = history[history.length - 1];
  const attempt = consecutiveCrashes(history, now, cfg);
  const profile = shedProfile(currentProfile, history, now, cfg);
  if (!last || last.kind === "clean_shutdown") {
    return { restart: false, delayMs: 0, attempt, profile: currentProfile, reason: "clean_shutdown" };
  }
  if (attempt > cfg.maxAttempts) {
    return { restart: false, delayMs: 0, attempt, profile, reason: "budget_exhausted" };
  }
  const base = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempt - 1), cfg.maxDelayMs);
  const jitter = 1 + cfg.jitterRatio * (random() * 2 - 1);
  const delayMs = Math.max(0, Math.round(base * jitter));
  return { restart: true, delayMs, attempt, profile, reason: "auto_restart" };
}
const CONSERVATIVE_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MINIMAL_FREE_BYTES = 700 * 1024 * 1024;
function profileForMemory(mem) {
  if (mem.freeBytes < MINIMAL_FREE_BYTES) return "minimal";
  if (mem.freeBytes < CONSERVATIVE_FREE_BYTES) return "conservative";
  return "full";
}
const PROFILE_ORDER = { full: 0, conservative: 1, minimal: 2 };
function minProfile(a, b) {
  return PROFILE_ORDER[a] >= PROFILE_ORDER[b] ? a : b;
}
function planCapabilities(mem, env, floor = "full") {
  const forced = env.BIMAX_FORCE_PROFILE;
  const profile = forced && forced in PROFILE_ORDER ? forced : minProfile(profileForMemory(mem), floor);
  const caps = [];
  const spawnEnv = {};
  spawnEnv.BIMAX_DEFER_GRAPH_LOAD = "1";
  caps.push({ id: "nativeCompression", enabled: true, reason: "built-in (works without the Headroom sidecar)" });
  caps.push({ id: "persistentGraph", enabled: true, reason: "core storage" });
  const headroomUserOn = env.BIMAX_DISABLE_HEADROOM === "0";
  if (headroomUserOn && profile === "full") {
    spawnEnv.BIMAX_DISABLE_HEADROOM = "0";
    caps.push({ id: "headroomProxy", enabled: true, reason: "env override (BIMAX_DISABLE_HEADROOM=0)" });
  } else {
    spawnEnv.BIMAX_DISABLE_HEADROOM = "1";
    caps.push({
      id: "headroomProxy",
      enabled: false,
      reason: headroomUserOn ? `low memory (profile ${profile})` : "off by default on desktop (set BIMAX_DISABLE_HEADROOM=0 to enable)"
    });
  }
  const codememRaw = env.BIMAX_DISABLE_CODEMEM ?? env.BIMAX_DISABLE_CODEBASE_MEMORY;
  const codememUserOff = codememRaw === "1";
  const codememUserOn = codememRaw === "0";
  const codememOn = codememUserOn || !codememUserOff && profile === "full";
  spawnEnv.BIMAX_DISABLE_CODEMEM = codememOn ? "0" : "1";
  spawnEnv.BIMAX_DISABLE_CODEBASE_MEMORY = codememOn ? "0" : "1";
  caps.push({
    id: "codebaseMemory",
    enabled: codememOn,
    reason: codememUserOn ? "env override" : codememUserOff ? "env override" : codememOn ? "default" : `deferred (profile ${profile})`
  });
  const autoIndexUserOff = env.BIMAX_AUTO_INDEX === "0";
  const autoIndexOn = !autoIndexUserOff && profile !== "minimal";
  spawnEnv.BIMAX_AUTO_INDEX = autoIndexOn ? "1" : "0";
  caps.push({
    id: "autoIndex",
    enabled: autoIndexOn,
    reason: autoIndexUserOff ? "env override" : autoIndexOn ? "default" : `deferred (profile ${profile})`
  });
  const drivesUserOff = env.BIMAX_DRIVES_BOOT === "0";
  const drivesOn = !drivesUserOff && profile === "full";
  spawnEnv.BIMAX_DRIVES_BOOT = drivesOn ? "1" : "0";
  caps.push({
    id: "drivesBoot",
    enabled: drivesOn,
    reason: drivesUserOff ? "env override" : drivesOn ? "default" : `deferred (profile ${profile})`
  });
  return { profile, capabilities: caps, env: spawnEnv };
}
function degradedCapabilities(plan) {
  return plan.capabilities.filter((c) => !c.enabled && c.id !== "headroomProxy").map((c) => c.id);
}
const CLIENT_MIN_COMPATIBLE_MAJOR = 2;
const CLIENT_MAX_COMPATIBLE_MAJOR = 3;
function supportsProtocolMajor(major) {
  return Number.isInteger(major) && major >= CLIENT_MIN_COMPATIBLE_MAJOR && major <= CLIENT_MAX_COMPATIBLE_MAJOR;
}
const DEFAULT_TIMEOUTS = {
  startupTimeoutMs: 12e4,
  // dev boots compile TS from source — generous on purpose
  idleHeartbeatTimeoutMs: 2e4,
  // heartbeats arrive every ~3s; 20s of silence is a wedge
  activeHeartbeatTimeoutMs: 6e5,
  // long legitimate work still ticks the timer-based heartbeat
  watchdogTickMs: 2e3,
  killEscalationMs: 3e3
};
const SESSION_ID_RE = /^[\w.:-]{1,128}$/;
function parseRecoveryAction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const a = raw.action;
  const sid = raw.sessionId;
  const sessionId = typeof sid === "string" && SESSION_ID_RE.test(sid) ? sid : void 0;
  switch (a) {
    case "retry":
      return { action: "retry" };
    case "restartSafe":
      return { action: "restartSafe", sessionId };
    case "resume":
      return sessionId ? { action: "resume", sessionId } : null;
    case "startMinimal":
      return { action: "startMinimal" };
    case "stop":
      return { action: "stop" };
    default:
      return null;
  }
}
const SAFE_REPLAY = /* @__PURE__ */ new Set(["ping", "query", "configGet"]);
const MAX_QUEUE = 32;
function isSafeToReplay(msg) {
  return !!msg && typeof msg === "object" && SAFE_REPLAY.has(String(msg.t));
}
class EngineSupervisor {
  constructor(deps, timeouts = DEFAULT_TIMEOUTS, policy = DEFAULT_POLICY) {
    this.deps = deps;
    this.timeouts = timeouts;
    this.policy = policy;
    this.enteredAt = deps.now();
    this.plan = planCapabilities(deps.memory(), deps.env, "full");
  }
  phase = "idle";
  enteredAt;
  attempt = 1;
  generation = 0;
  reason = "idle";
  child = null;
  childGen = 0;
  spawnedAt = 0;
  childProtocol = null;
  childIdentity = null;
  intentionalStop = false;
  watchdogVerdict = null;
  malformedLines = 0;
  plan;
  profileFloor = "full";
  heartbeat = null;
  heartbeatSeen = false;
  history = [];
  projectDir = "";
  queue = [];
  pendingResume = null;
  lastSession = null;
  interruptedSessionId = null;
  watchdogTimer = null;
  restartTimer = null;
  restartAt = 0;
  killTimers = /* @__PURE__ */ new Set();
  disposed = false;
  // --- public surface --------------------------------------------------------------------------
  get currentProject() {
    return this.projectDir;
  }
  status() {
    return {
      phase: this.phase,
      enteredAt: this.enteredAt,
      attempt: this.attempt,
      generation: this.generation,
      message: phaseMessage(this.phase),
      reason: this.reason,
      recoverable: this.phase === "failed" ? true : void 0,
      progress: bootProgress(this.phase),
      pid: this.child?.pid,
      profile: this.plan.profile,
      capabilities: this.plan.capabilities,
      degradedCapabilities: degradedCapabilities(this.plan),
      lastHeartbeat: this.heartbeat,
      countdownMs: this.phase === "restarting" ? Math.max(0, this.restartAt - this.deps.now()) : void 0,
      interruptedSessionId: this.interruptedSessionId ?? void 0
    };
  }
  /** Open (or switch to) a project: supersede any running child, fresh restart budget. */
  openProject(dir) {
    if (this.disposed) return;
    this.projectDir = dir;
    this.history = [];
    this.profileFloor = "full";
    this.attempt = 1;
    this.interruptedSessionId = null;
    this.lastSession = null;
    this.pendingResume = null;
    this.queue = [];
    this.cancelScheduledRestart();
    this.supersedeChild();
    this.spawnChild();
  }
  /** Intentional stop — never auto-restarted. */
  stop() {
    this.cancelScheduledRestart();
    if (!this.child) {
      if (this.phase !== "idle") this.enter("idle", "stopped");
      return;
    }
    this.intentionalStop = true;
    this.enter("stopping", "stop_requested");
    this.terminateChild(this.child);
  }
  /** App quit: stop everything and make sure no timer can relaunch the engine afterwards. */
  dispose() {
    this.disposed = true;
    this.cancelScheduledRestart();
    this.stopWatchdog();
    for (const t of this.killTimers) this.deps.clearTimeout(t);
    this.killTimers.clear();
    const child = this.child;
    this.supersedeChild();
    if (child) {
      try {
        child.endStdin();
      } catch {
      }
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
  }
  /** A validated renderer recovery action. Returns false when the payload was malformed. */
  handleAction(raw) {
    const action = parseRecoveryAction(raw);
    if (!action) {
      this.deps.onNotice("warn", "Ignored malformed recovery action from the renderer.");
      return false;
    }
    switch (action.action) {
      case "retry":
        this.manualRestart(this.profileFloor);
        return true;
      case "restartSafe":
        if (action.sessionId) this.pendingResume = action.sessionId;
        this.manualRestart(minProfile(this.profileFloor, "conservative"));
        return true;
      case "startMinimal":
        this.manualRestart("minimal");
        return true;
      case "resume":
        this.requestResume(action.sessionId);
        return true;
      case "stop":
        this.stop();
        return true;
    }
  }
  /**
   * A protocol message from the renderer. Delivered when the engine is interactive; queued when
   * it's merely a safe-to-replay read; rejected (with a visible notice) otherwise — an unsafe
   * message must never be silently replayed into a different engine process.
   */
  sendFromRenderer(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.t !== "string") {
      this.deps.onNotice("warn", "Ignored malformed engine message from the renderer.");
      return;
    }
    const t = String(raw.t);
    if ((this.phase === "ready" || this.phase === "degraded") && this.child) {
      this.writeToChild(raw);
      return;
    }
    if (isSafeToReplay(raw)) {
      this.queue.push(raw);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
      return;
    }
    if (t === "interrupt") return;
    this.deps.onNotice("warn", `Engine is not ready (${this.phase}) — "${t}" was not delivered. Retry once the engine is back.`);
  }
  /** Resume a saved session: immediately when ready, otherwise after the next successful start. */
  requestResume(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) {
      this.deps.onNotice("warn", "Ignored resume request with an invalid session id.");
      return;
    }
    if ((this.phase === "ready" || this.phase === "degraded") && this.child) {
      this.sendResume(sessionId);
      return;
    }
    this.pendingResume = sessionId;
    if (!this.child && this.phase !== "restarting") this.manualRestart(this.profileFloor);
  }
  crashHistory() {
    return this.deps.journal.list();
  }
  /** Plain-text diagnostics for the "Copy diagnostics" button. Already redacted via the journal. */
  diagnosticsText() {
    const s = this.status();
    const lines = [
      `Bimax engine diagnostics — ${new Date(this.deps.now()).toISOString()}`,
      `project: ${this.projectDir || "(none)"}`,
      `phase: ${s.phase} (${s.reason}) attempt ${s.attempt} generation ${s.generation}`,
      `profile: ${s.profile}  pid: ${s.pid ?? "-"}  protocol: ${this.childProtocol ?? "-"}`,
      `capabilities: ${s.capabilities.map((c) => `${c.id}=${c.enabled ? "on" : `off(${c.reason})`}`).join(", ")}`,
      `lastHeartbeat: ${s.lastHeartbeat ? JSON.stringify(s.lastHeartbeat) : "none"}`,
      "",
      "Recent crashes:",
      ...this.crashHistory().slice(-5).map((r) => `  ${r.at} ${r.kind} phase=${r.lastPhase} uptime=${Math.round(r.uptimeMs / 1e3)}s exit=${r.exitCode ?? r.signal} attempt=${r.attempt} recovery=${r.recovery}`)
    ];
    return lines.join("\n");
  }
  // --- child lifecycle -------------------------------------------------------------------------
  manualRestart(floor) {
    if (this.disposed || !this.projectDir) return;
    if (this.child && isStartupPhase(this.phase)) {
      this.deps.onNotice("info", "Engine is already starting.");
      return;
    }
    this.cancelScheduledRestart();
    this.profileFloor = floor;
    this.supersedeChild();
    this.attempt = 1;
    this.spawnChild();
  }
  spawnChild() {
    if (this.disposed) return;
    if (!transition(this.phase, "spawning").ok) this.enter("restarting", "relaunch");
    this.generation += 1;
    const gen = this.generation;
    this.childGen = gen;
    this.intentionalStop = false;
    this.watchdogVerdict = null;
    this.heartbeatSeen = false;
    this.heartbeat = null;
    this.childProtocol = null;
    this.childIdentity = null;
    this.malformedLines = 0;
    this.plan = planCapabilities(this.deps.memory(), this.deps.env, this.profileFloor);
    this.enter("spawning", "launch");
    let handle;
    try {
      handle = this.deps.spawn(this.projectDir, this.plan.env, {
        onMessage: (m) => this.onChildMessage(gen, m),
        onMalformed: (l) => this.onChildMalformed(gen, l),
        onExit: (code, signal) => this.onChildExit(gen, code, signal),
        onError: (err) => this.onChildError(gen, err)
      });
    } catch (err) {
      this.handleDeath(gen, null, null, true, err instanceof Error ? err.message : String(err));
      return;
    }
    this.child = handle;
    this.spawnedAt = this.deps.now();
    this.startWatchdog();
    this.emitStatus();
  }
  onChildMessage(gen, msg) {
    if (gen !== this.childGen) return;
    const t = String(msg.t ?? "");
    if (t === "hello") {
      const major = Number(msg.protocolMajor);
      const engineMin = Number(msg.minCompatibleMajor);
      const engineMax = Number(msg.maxCompatibleMajor);
      const overlaps = Number.isInteger(engineMin) && Number.isInteger(engineMax) && Math.max(engineMin, CLIENT_MIN_COMPATIBLE_MAJOR) <= Math.min(engineMax, CLIENT_MAX_COMPATIBLE_MAJOR) && supportsProtocolMajor(major);
      if (!overlaps) {
        this.childProtocol = Number.isFinite(major) ? major : null;
        this.watchdogVerdict = "protocol_failure";
        this.deps.onNotice("error", `Engine protocol ${String(msg.protocolVersion ?? major)} is incompatible with Desktop ${CLIENT_MIN_COMPATIBLE_MAJOR}–${CLIENT_MAX_COMPATIBLE_MAJOR}.`);
        this.killCurrentChild();
        return;
      }
      const identity = msg.engine;
      this.childProtocol = major;
      this.childIdentity = {
        version: String(identity?.version ?? "unknown"),
        buildCommit: String(identity?.buildCommit ?? "unknown"),
        features: Array.isArray(msg.features) ? msg.features.map(String) : []
      };
    } else if (t === "boot") {
      const phase = String(msg.phase ?? "");
      const res = transition(this.phase, phase);
      if (res.ok && res.phase !== this.phase) this.enter(res.phase, "boot_progress");
    } else if (t === "health") {
      const h = msg;
      this.heartbeat = {
        at: this.deps.now(),
        uptimeMs: Number(h.uptimeMs) || 0,
        rssMb: Number(h.rssMb) || 0,
        heapMb: Number(h.heapMb) || 0,
        eventLoopDelayMs: Number(h.eventLoopDelayMs) || 0,
        activeTurn: !!h.activeTurn
      };
      this.heartbeatSeen = true;
      this.emitStatus();
    } else if (t === "ready") {
      const legacyMajor = Number(msg.protocol) || null;
      if (this.childProtocol === null) this.childProtocol = legacyMajor;
      if (legacyMajor !== null && !supportsProtocolMajor(legacyMajor)) {
        this.watchdogVerdict = "protocol_failure";
        this.deps.onNotice("error", `Engine protocol v${legacyMajor} is incompatible with Desktop ${CLIENT_MIN_COMPATIBLE_MAJOR}–${CLIENT_MAX_COMPATIBLE_MAJOR}.`);
        this.killCurrentChild();
        return;
      }
      const degraded = degradedCapabilities(this.plan).length > 0;
      const res = transition(this.phase, degraded ? "degraded" : "ready");
      if (res.ok) this.enter(res.phase, degraded ? "capabilities_shed" : "ready");
      this.flushQueue();
      this.maybeSendPendingResume();
    } else if (t === "event" && msg.name === "ui_snapshot") {
      this.sniffSession(msg);
    }
    this.deps.onMessage(msg);
  }
  onChildMalformed(gen, _line) {
    if (gen !== this.childGen) return;
    this.malformedLines += 1;
    if (this.childProtocol === null && this.malformedLines > 20 && !this.watchdogVerdict) {
      this.watchdogVerdict = "protocol_failure";
      this.killCurrentChild();
    }
  }
  onChildError(gen, err) {
    if (gen !== this.childGen) return;
    this.handleDeath(gen, null, null, true, err.message);
  }
  onChildExit(gen, code, signal) {
    if (gen !== this.childGen) {
      this.deps.onNotice("info", `Previous engine process exited (${signal ?? `code ${code ?? "?"}`}).`);
      return;
    }
    this.handleDeath(gen, code, signal, false);
  }
  handleDeath(gen, code, signal, spawnError, detail) {
    if (gen !== this.childGen) return;
    const now = this.deps.now();
    const lastPhase = this.phase;
    const child = this.child;
    this.child = null;
    this.stopWatchdog();
    const kind = classifyExit({
      code,
      signal,
      intentional: this.intentionalStop,
      watchdog: this.watchdogVerdict ?? void 0,
      spawnError
    });
    const uptimeMs = this.spawnedAt ? now - this.spawnedAt : 0;
    this.history.push({ at: now, kind, uptimeMs });
    const interrupted = kind !== "clean_shutdown" && (this.heartbeat?.activeTurn === true || (this.lastSession?.messageCount ?? 0) > 0);
    if (interrupted && this.lastSession) this.interruptedSessionId = this.lastSession.id;
    const mem = this.deps.memory();
    const record = {
      at: new Date(now).toISOString(),
      project: this.projectDir,
      sessionId: this.lastSession?.id,
      command: child?.command ?? "unknown",
      protocol: this.childProtocol ?? void 0,
      pid: child?.pid,
      uptimeMs,
      exitCode: code,
      signal,
      kind,
      lastPhase,
      lastHeartbeat: this.heartbeat,
      memory: { freeMb: Math.round(mem.freeBytes / 1048576), totalMb: Math.round(mem.totalBytes / 1048576) },
      profile: this.plan.profile,
      capabilities: this.plan.capabilities.map((c) => ({ id: c.id, enabled: c.enabled })),
      attempt: this.attempt,
      logTail: (detail ? `[spawn] ${detail}
` : "") + this.deps.logTail(),
      interruptedWork: interrupted,
      recovery: "manual"
    };
    if (this.intentionalStop || this.disposed) {
      record.recovery = "intentional";
      this.deps.journal.append(record);
      this.enter(this.disposed ? "exited" : "exited", "clean_shutdown");
      return;
    }
    if (kind === "clean_shutdown") {
      record.recovery = "intentional";
      this.deps.journal.append(record);
      this.enter("exited", "clean_shutdown");
      return;
    }
    const decision = decideRestart(this.history, now, this.plan.profile, this.policy, this.deps.random);
    if (kind === "external_kill" || kind === "unresponsive") {
      this.profileFloor = minProfile(this.profileFloor, decision.profile);
    }
    if (decision.restart) {
      record.recovery = "auto_restart";
      this.deps.journal.append(record);
      this.attempt = decision.attempt;
      this.enter("restarting", kind);
      this.restartAt = now + decision.delayMs;
      this.emitStatus();
      this.restartTimer = this.deps.setTimeout(() => {
        this.restartTimer = null;
        this.spawnChild();
      }, decision.delayMs);
      this.deps.onNotice("warn", `Engine ${describeKind(kind)} — restarting in ${Math.round(decision.delayMs / 1e3)}s (attempt ${decision.attempt}/${this.policy.maxAttempts}).`);
    } else if (decision.reason === "budget_exhausted") {
      record.recovery = "budget_exhausted";
      this.deps.journal.append(record);
      this.enter("failed", "restart_budget_exhausted");
      this.deps.onNotice("error", `Engine ${describeKind(kind)} ${decision.attempt} times — automatic restarts paused. Use Retry or Start without optional services.`);
    } else {
      record.recovery = "manual";
      this.deps.journal.append(record);
      this.enter("exited", kind);
    }
  }
  // --- watchdog --------------------------------------------------------------------------------
  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = this.deps.setInterval(() => this.tick(), this.timeouts.watchdogTickMs);
  }
  stopWatchdog() {
    if (this.watchdogTimer !== null) {
      this.deps.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
  /** One watchdog evaluation. Public-ish for tests (deterministic, clock-injected). */
  tick() {
    if (!this.child || this.watchdogVerdict) return;
    const now = this.deps.now();
    if (isStartupPhase(this.phase)) {
      if (now - this.spawnedAt > this.timeouts.startupTimeoutMs) {
        this.watchdogVerdict = "startup_timeout";
        this.deps.onNotice("warn", `Engine did not become ready within ${Math.round(this.timeouts.startupTimeoutMs / 1e3)}s — restarting it.`);
        this.killCurrentChild();
      }
      return;
    }
    if ((this.phase === "ready" || this.phase === "degraded") && this.heartbeatSeen && this.heartbeat) {
      const limit = this.heartbeat.activeTurn ? this.timeouts.activeHeartbeatTimeoutMs : this.timeouts.idleHeartbeatTimeoutMs;
      if (now - this.heartbeat.at > limit) {
        this.watchdogVerdict = "unresponsive";
        this.deps.onNotice("warn", "Engine stopped responding — restarting it.");
        this.killCurrentChild();
      }
    }
  }
  killCurrentChild() {
    if (this.child) this.terminateChild(this.child);
  }
  /** SIGTERM, then SIGKILL if the child lingers. The exit event drives everything else. */
  terminateChild(child) {
    try {
      child.endStdin();
    } catch {
    }
    try {
      child.kill("SIGTERM");
    } catch {
    }
    const t = this.deps.setTimeout(() => {
      this.killTimers.delete(t);
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, this.timeouts.killEscalationMs);
    this.killTimers.add(t);
  }
  /** Detach the current child from state (its events become stale) without waiting for its exit. */
  supersedeChild() {
    const child = this.child;
    this.child = null;
    this.childGen = -1;
    if (child) this.terminateChild(child);
  }
  cancelScheduledRestart() {
    if (this.restartTimer !== null) {
      this.deps.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
  // --- helpers ---------------------------------------------------------------------------------
  writeToChild(msg) {
    if (!this.child) return;
    try {
      this.child.write(JSON.stringify(msg) + "\n");
    } catch {
    }
  }
  flushQueue() {
    const queued = this.queue;
    this.queue = [];
    for (const msg of queued) this.writeToChild(msg);
  }
  maybeSendPendingResume() {
    if (!this.pendingResume) return;
    if (this.childProtocol !== null && this.childProtocol < 3) {
      this.deps.onNotice("warn", `Engine protocol v${this.childProtocol} predates typed resume — skipped automatic session resume.`);
      this.pendingResume = null;
      return;
    }
    const id = this.pendingResume;
    this.pendingResume = null;
    this.sendResume(id);
  }
  sendResume(sessionId) {
    this.writeToChild({ t: "resume", id: sessionId });
    this.interruptedSessionId = null;
    this.emitStatus();
  }
  sniffSession(msg) {
    try {
      const args = msg.args;
      const snapshot = args?.[0];
      const cur = snapshot?.sessions?.find((s) => s.current);
      if (cur?.id) this.lastSession = { id: String(cur.id), messageCount: Number(cur.messageCount) || 0 };
    } catch {
    }
  }
  enter(phase, reason) {
    const res = transition(this.phase, phase);
    if (!res.ok) return;
    if (res.phase === this.phase && this.reason === reason) return;
    this.phase = res.phase;
    this.reason = reason;
    this.enteredAt = this.deps.now();
    this.emitStatus();
  }
  emitStatus() {
    this.deps.onStatus(this.status());
  }
}
function describeKind(kind) {
  switch (kind) {
    case "external_kill":
      return "was force-terminated (likely memory pressure)";
    case "startup_timeout":
      return "timed out during startup";
    case "unresponsive":
      return "stopped responding";
    case "protocol_failure":
      return "produced an invalid protocol stream";
    case "spawn_error":
      return "could not be launched";
    case "crash":
      return "crashed";
    case "clean_shutdown":
      return "exited";
  }
}
const REDACTIONS = [
  // bearer headers — must run BEFORE the key=value rule: in `authorization: Bearer <jwt>` that
  // rule's \S+ value consumes just the word "Bearer", leaving the token itself in the clear
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  // key=value style env/config assignments for sensitive names
  [/((?:api[-_]?key|secret|token|password|passwd|credential|authorization)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]"],
  // bare JWT shape (three dot-separated base64url segments), wherever it appears
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[REDACTED]"],
  // well-known key shapes: OpenAI/Anthropic-style sk-…, GitHub ghp_…, AWS AKIA…
  [/\b(sk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"]
];
function redactSecrets(text) {
  let out = text;
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return out;
}
function appendRecord(records, rec) {
  const clamped = {
    ...rec,
    logTail: redactSecrets(rec.logTail ?? "").slice(-6e3)
  };
  return [...records, clamped].slice(-30);
}
function parseJournal(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.records) ? parsed.records : [];
  } catch {
    return [];
  }
}
function serializeJournal(records) {
  return JSON.stringify({ version: 1, records }, null, 2);
}
class CrashJournal {
  constructor(store) {
    this.store = store;
  }
  list() {
    return parseJournal(this.store.load());
  }
  append(rec) {
    const next = appendRecord(this.list(), rec);
    try {
      this.store.save(serializeJournal(next));
    } catch {
    }
    return next;
  }
  /** Patch the most recent record (e.g. fill in the recovery outcome once known). */
  amendLast(patch) {
    const records = this.list();
    if (records.length === 0) return;
    records[records.length - 1] = { ...records[records.length - 1], ...patch };
    try {
      this.store.save(serializeJournal(records));
    } catch {
    }
  }
}
const REQUIRED_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false
};
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
function isTrustedRendererUrl(url, devServerUrl) {
  if (!url) return false;
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith("file://");
}
function isTrustedSender(sender, trusted) {
  if (trusted.webContentsId === null) return false;
  const allowed = sender.senderId === trusted.webContentsId || (trusted.auxiliaryWebContentsIds ?? []).includes(sender.senderId);
  if (!allowed) return false;
  if (!sender.isMainFrame) return false;
  return isTrustedRendererUrl(sender.frameUrl, trusted.devServerUrl);
}
function isAllowedNavigation(url, trusted) {
  return isTrustedRendererUrl(url, trusted.devServerUrl);
}
function isAllowedPermission() {
  return false;
}
class InvalidPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPayloadError";
  }
}
const MAX_PATH_LENGTH = 4096;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_PTY_INPUT = 64 * 1024;
function asBoundedInt(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new InvalidPayloadError(`${label} must be an integer`);
  }
  if (value < min || value > max) throw new InvalidPayloadError(`${label} out of range: ${value}`);
  return value;
}
function asBoundedString(value, max, label) {
  if (typeof value !== "string") throw new InvalidPayloadError(`${label} must be a string`);
  if (value.length > max) throw new InvalidPayloadError(`${label} exceeds ${max} characters`);
  return value;
}
function asPtyInput(value) {
  return asBoundedString(value, MAX_PTY_INPUT, "pty input");
}
function asFileContent(value) {
  return asBoundedString(value, MAX_WRITE_BYTES, "file content");
}
function resolveWithinRoot(root, rel, label = "path") {
  if (typeof root !== "string" || root === "" || !path.isAbsolute(root)) {
    throw new InvalidPayloadError(`${label} rejected: no project is open`);
  }
  const relative = asBoundedString(rel ?? "", MAX_PATH_LENGTH, label);
  if (relative.includes("\0")) throw new InvalidPayloadError(`${label} contains a NUL byte`);
  const base = path.resolve(root);
  const abs = path.resolve(base, relative || ".");
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new InvalidPayloadError(`${label} escapes the project: ${relative}`);
  }
  return abs;
}
function asGitPathspec(root, rel) {
  const abs = resolveWithinRoot(root, rel, "git path");
  const relative = path.relative(path.resolve(root), abs);
  return relative === "" ? "." : `./${relative}`;
}
const SUPERVISOR_ACTIONS = ["retry", "restart-safe", "resume", "minimal", "stop"];
function asSupervisorAction(value) {
  if (typeof value !== "object" || value === null) {
    throw new InvalidPayloadError("supervisor action must be an object");
  }
  const raw = value;
  const action = raw.action;
  if (typeof action !== "string" || !SUPERVISOR_ACTIONS.includes(action)) {
    throw new InvalidPayloadError(`unknown supervisor action: ${String(action)}`);
  }
  const out = { action };
  if (raw.sessionId !== void 0) out.sessionId = asBoundedString(raw.sessionId, 256, "sessionId");
  return out;
}
function isProtocolFrame(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tag = value.t;
  return typeof tag === "string" && tag.length > 0 && tag.length <= 64;
}
function run(cwd, args) {
  return new Promise((resolve, reject) => {
    node_child_process.execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}
async function numstat(cwd, staged) {
  const map = /* @__PURE__ */ new Map();
  try {
    const out = await run(cwd, staged ? ["diff", "--cached", "--numstat"] : ["diff", "--numstat"]);
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const prev = map.get(m[3]) ?? { ins: 0, del: 0 };
      map.set(m[3], {
        ins: prev.ins + (m[1] === "-" ? 0 : Number(m[1])),
        del: prev.del + (m[2] === "-" ? 0 : Number(m[2]))
      });
    }
  } catch {
  }
  return map;
}
async function gitStatus(cwd) {
  let out;
  try {
    out = await run(cwd, ["status", "--porcelain=v2", "--branch"]);
  } catch {
    return null;
  }
  const res = { branch: "", ahead: 0, behind: 0, files: [] };
  const [unstagedCounts, stagedCounts] = await Promise.all([numstat(cwd, false), numstat(cwd, true)]);
  const counts = (p) => {
    const a = unstagedCounts.get(p);
    const b = stagedCounts.get(p);
    return { insertions: (a?.ins ?? 0) + (b?.ins ?? 0), deletions: (a?.del ?? 0) + (b?.del ?? 0) };
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      res.branch = line.slice(14).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const pathField = parts.slice(line.startsWith("2 ") ? 9 : 8).join(" ");
      const p = pathField.split("	")[0];
      const worktree = xy[1] !== "." ? xy[1] : "";
      const index = xy[0] !== "." ? xy[0] : "";
      res.files.push({
        path: p,
        status: worktree || index || "M",
        staged: index !== "",
        ...counts(p)
      });
    } else if (line.startsWith("? ")) {
      res.files.push({ path: line.slice(2), status: "?", staged: false, insertions: 0, deletions: 0 });
    }
  }
  res.files.sort((a, b) => a.path.localeCompare(b.path));
  return res;
}
async function gitDiff(cwd, file, untracked) {
  const pathspec = asGitPathspec(cwd, file);
  try {
    if (untracked) {
      return await run(cwd, ["diff", "--no-index", "--", "/dev/null", pathspec]);
    }
    return await run(cwd, ["diff", "HEAD", "--", pathspec]);
  } catch {
    try {
      return await run(cwd, ["diff", "--", pathspec]);
    } catch {
      return "";
    }
  }
}
async function gitBranches(cwd) {
  try {
    const [cur, list] = await Promise.all([
      run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      run(cwd, ["branch", "--format=%(refname:short)"])
    ]);
    return { current: cur.trim(), all: list.split("\n").map((s) => s.trim()).filter(Boolean) };
  } catch {
    return { current: "", all: [] };
  }
}
async function gitLog(cwd, n) {
  try {
    const out = await run(cwd, ["log", `-${Math.max(1, Math.min(n, 100))}`, "--format=%h%x09%s%x09%cr"]);
    return out.split("\n").filter(Boolean).map((line) => {
      const [hash, subject, when] = line.split("	");
      return { hash, subject: subject ?? "", when: when ?? "" };
    });
  } catch {
    return [];
  }
}
const IGNORE = /* @__PURE__ */ new Set(["node_modules", ".git", ".DS_Store"]);
const MAX_READ = 512 * 1024;
function safeJoin(root, rel) {
  return resolveWithinRoot(root, rel, "path");
}
async function listDir(root, rel) {
  const abs = safeJoin(root, rel);
  const entries = await node_fs.promises.readdir(abs, { withFileTypes: true });
  return entries.filter((e) => !IGNORE.has(e.name)).map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
}
async function readFilePreview(root, rel) {
  const abs = safeJoin(root, rel);
  const stat = await node_fs.promises.stat(abs);
  const fh = await node_fs.promises.open(abs, "r");
  try {
    const len = Math.min(stat.size, MAX_READ);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const binary = buf.includes(0);
    return {
      content: binary ? "" : buf.toString("utf8"),
      truncated: stat.size > MAX_READ,
      size: stat.size,
      binary
    };
  } finally {
    await fh.close();
  }
}
async function writeFileContent(root, rel, content) {
  const abs = safeJoin(root, rel);
  await node_fs.promises.writeFile(abs, content, "utf8");
}
async function readSessionMeta(root) {
  try {
    const raw = await node_fs.promises.readFile(path.join(root, ".breakglass", "sessions", "sessions-meta.jsonl"), "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        out.push({
          id: String(m.id ?? ""),
          title: String(m.title ?? ""),
          cwd: String(m.cwd ?? ""),
          startedAt: String(m.startedAt ?? ""),
          endedAt: m.endedAt ? String(m.endedAt) : void 0,
          messageCount: Number(m.messageCount ?? 0),
          tokenEstimate: Number(m.tokenEstimate ?? 0)
        });
      } catch {
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}
function watchProject(root, onChange) {
  let timer = null;
  try {
    const watcher = node_fs.watch(root, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? "");
      if (name.split(path.sep).some((seg) => IGNORE.has(seg))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 400);
    });
    watcher.on("error", () => {
    });
    return watcher;
  } catch {
    return null;
  }
}
let nextId = 1;
const sessions = /* @__PURE__ */ new Map();
function createPty(cwd, cols, rows, events) {
  const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/zsh";
  const id = nextId++;
  const pty = nodePty.spawn(shell, process.platform === "win32" ? [] : ["-l"], {
    name: "xterm-256color",
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
  });
  sessions.set(id, pty);
  pty.onData((data) => events.onData(id, data));
  pty.onExit(({ exitCode }) => {
    sessions.delete(id);
    events.onExit(id, exitCode);
  });
  return id;
}
function writePty(id, data) {
  sessions.get(id)?.write(data);
}
function resizePty(id, cols, rows) {
  try {
    sessions.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
  } catch {
  }
}
function killPty(id) {
  const pty = sessions.get(id);
  sessions.delete(id);
  try {
    pty?.kill();
  } catch {
  }
}
function killAllPtys() {
  for (const id of [...sessions.keys()]) killPty(id);
}
const MAX_RECENTS = 8;
function settingsPath() {
  return path.join(electron.app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    const raw = JSON.parse(node_fs.readFileSync(settingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  try {
    const next = { ...loadSettings(), ...patch };
    node_fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    node_fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch {
  }
}
function isRealProject(dir) {
  if (!dir || typeof dir !== "string") return false;
  try {
    const full = path.resolve(dir);
    if (full === path.resolve(os.homedir())) return false;
    return node_fs.existsSync(full) && node_fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}
function pickInitialProject(saved, envCwd = process.env.BIMAX_CWD) {
  if (isRealProject(envCwd)) return path.resolve(envCwd);
  if (isRealProject(saved)) return path.resolve(saved);
  return null;
}
function withRecent(recents, dir) {
  const norm = path.resolve(dir);
  const rest = (recents ?? []).map((r) => path.resolve(r)).filter((r) => r !== norm);
  return [norm, ...rest].slice(0, MAX_RECENTS);
}
function recordProject(dir) {
  if (!isRealProject(dir)) return;
  const cur = loadSettings();
  const recents = withRecent(cur.recentProjects, dir).filter(isRealProject);
  saveSettings({ lastProject: path.resolve(dir), recentProjects: recents });
}
function recentProjects() {
  return (loadSettings().recentProjects ?? []).filter(isRealProject);
}
const FRESH_MS = 750;
const HELPER_TIMEOUT_MS = 2e3;
let cached = null;
let probe = () => helperGrants();
function toDisposition$1(value) {
  if (value === true || value === "granted") return "granted";
  if (value === false) return "denied";
  if (value === "denied" || value === "restricted") return "denied";
  if (value === "not-determined" || value === "unknown") return "not-determined";
  return "unavailable";
}
function inProcessGrants() {
  if (process.platform !== "darwin") {
    return { accessibility: "unavailable", screenRecording: "unavailable" };
  }
  return {
    accessibility: toDisposition$1(electron.systemPreferences.isTrustedAccessibilityClient(false)),
    screenRecording: toDisposition$1(electron.systemPreferences.getMediaAccessStatus("screen"))
  };
}
function helperGrants() {
  if (process.platform !== "darwin") return null;
  const helper = bimaxDesktopHelperBinary();
  if (!helper) return null;
  try {
    const stdout = node_child_process.execFileSync(helper, ["status"], {
      encoding: "utf8",
      timeout: HELPER_TIMEOUT_MS,
      // The helper writes one JSON line. Nothing here should reach a terminal.
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
    if (parsed?.ok !== true) return null;
    return {
      accessibility: parsed.accessibility === true,
      screenRecording: parsed.screenRecording === true
    };
  } catch {
    return null;
  }
}
function hostGrants(force = false) {
  const now = Date.now();
  if (!force && cached && now - cached.readAt < FRESH_MS) return cached;
  const inProcess = inProcessGrants();
  const fresh = probe();
  const resolve = (live, fallback) => {
    if (live === void 0) return fallback;
    if (live) return "granted";
    return fallback === "granted" ? "denied" : fallback;
  };
  cached = {
    accessibility: resolve(fresh?.accessibility, inProcess.accessibility),
    screenRecording: resolve(fresh?.screenRecording, inProcess.screenRecording),
    source: fresh ? "helper" : "in-process",
    readAt: now
  };
  return cached;
}
function invalidateHostGrants() {
  cached = null;
}
let coach = null;
let preparedDragIcon = null;
let preparedDragBundle = null;
let restoreMainWindow = null;
let nativeDragActive = false;
let completedNativeDrag = false;
let watchGrantAfterCompletedDrag = false;
let droppedPane = null;
let droppedIdentityOwner = "host";
let deferredStopReason = null;
let destroyTimer = null;
let grantWatch = null;
const DRAG_SETTLE_MS = 1200;
const GRANT_WATCH_MS = 5 * 6e4;
const GRANT_POLL_MS = 1e3;
const ACTIVATION_IS_OURS_MS = 4e3;
function logCoach(event, detail = {}) {
  console.info(`[permission-coach] ${JSON.stringify({ event, ...detail })}`);
}
const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
};
async function openPermissionPane(url) {
  await electron.shell.openExternal(url);
  const major = Number.parseInt(process.getSystemVersion().split(".")[0] || "0", 10);
  if (Number.isFinite(major) && major >= 26) {
    await new Promise((resolve) => setTimeout(resolve, 420));
    await electron.shell.openExternal(url);
  }
}
function permissionDragNeedsGrantWatch(pane, _identityOwner = "host") {
  return pane === "accessibility" || pane === "screenRecording" || pane === "fullDisk";
}
function toDisposition(raw) {
  if (raw === true || raw === "granted") return "granted";
  if (raw === false || raw === "denied" || raw === "restricted") return "denied";
  if (raw === "not-determined" || raw === "unknown") return "not-determined";
  return "unavailable";
}
function grantReading(pane, identityOwner) {
  if (process.platform !== "darwin" || identityOwner === "service") return "unavailable";
  if (pane === "accessibility") return hostGrants().accessibility;
  if (pane === "screenRecording") return hostGrants().screenRecording;
  if (pane === "fullDisk") return probeFullDisk();
  return "unavailable";
}
function endGrantWatch(reason = "superseded", restore = "leave-hidden") {
  if (!grantWatch) return;
  const watch = grantWatch;
  grantWatch = null;
  clearInterval(watch.timer);
  electron.app.removeListener("did-become-active", watch.onActive);
  electron.app.removeListener("activate", watch.onActive);
  logCoach("grant-watch-end", {
    pane: watch.pane,
    reason,
    waitedMs: Date.now() - watch.startedAt,
    reading: grantReading(watch.pane, watch.identityOwner),
    restored: restore === "restore"
  });
  if (restore === "restore") watch.restore?.();
}
function isAwaitingHostGrant() {
  return grantWatch !== null;
}
function beginGrantWatch(pane, identityOwner, restore) {
  endGrantWatch("restarted");
  const startedAt = Date.now();
  invalidateHostGrants();
  const settle = (reason) => endGrantWatch(reason, "restore");
  const onActive = () => {
    if (Date.now() - startedAt < ACTIVATION_IS_OURS_MS) {
      logCoach("grant-watch-ignored-activation", { pane, sinceMs: Date.now() - startedAt });
      return;
    }
    settle("user-returned");
  };
  grantWatch = {
    pane,
    identityOwner,
    startedAt,
    onActive,
    restore,
    timer: setInterval(() => {
      if (grantReading(pane, identityOwner) === "granted") {
        settle("granted");
        return;
      }
      if (Date.now() - startedAt >= GRANT_WATCH_MS) settle("timed-out");
    }, GRANT_POLL_MS)
  };
  electron.app.on("did-become-active", onActive);
  electron.app.on("activate", onActive);
  logCoach("grant-watch-start", { pane, identityOwner, reading: grantReading(pane, identityOwner) });
}
function probePermissions() {
  const darwin = process.platform === "darwin";
  const bundle = draggableBundlePath() ?? process.execPath;
  const name = path__namespace.basename(bundle, ".app");
  const host = hostGrants();
  const probe2 = {
    responsibleBundle: bundle,
    responsibleName: name,
    readingSource: host.source,
    // Anything whose bundle name is not Bimax is a host we are borrowing — the grant belongs to it.
    isDevHost: darwin && !/^bimax$/i.test(name),
    readings: {
      // Fresh-child readings. This probe is what the Trust Center renders, so a stale positive here
      // is what made the app insist a granted permission was off no matter how many times the user
      // granted it.
      accessibility: darwin ? host.accessibility : "unavailable",
      screenRecording: darwin ? host.screenRecording : "unavailable",
      // Microphone stays in-process: it is prompt-driven, and the prompt's own callback updates
      // this process, so there is no staleness to correct.
      microphone: darwin ? toDisposition(electron.systemPreferences.getMediaAccessStatus("microphone")) : "unavailable",
      // There is no query API for Full Disk Access, so probe it the only honest way: attempt a read
      // that ONLY succeeds with the grant. TCC.db is the canonical marker and the read is harmless.
      fullDisk: darwin ? probeFullDisk() : "unavailable"
    }
  };
  logCoach("probe", {
    ...probe2.readings,
    readingSource: probe2.readingSource,
    responsible: bundle,
    isDevHost: probe2.isDevHost
  });
  return probe2;
}
function probeFullDisk() {
  const tcc = path__namespace.join(electron.app.getPath("home"), "Library", "Application Support", "com.apple.TCC", "TCC.db");
  try {
    fs__namespace.accessSync(tcc, fs__namespace.constants.R_OK);
    return "granted";
  } catch (error) {
    return error?.code === "ENOENT" ? "not-determined" : "denied";
  }
}
function draggableBundlePath() {
  if (process.platform !== "darwin") return null;
  const exe = process.execPath;
  const marker = ".app/Contents/MacOS/";
  const at = exe.indexOf(marker);
  if (at === -1) return null;
  const bundle = exe.slice(0, at + ".app".length);
  try {
    return fs__namespace.existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
}
function bundleIcon() {
  const width = 64;
  const height = 64;
  const radius = 14;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nearestX = Math.min(x, width - 1 - x);
      const nearestY = Math.min(y, height - 1 - y);
      const cornerX = Math.max(0, radius - nearestX);
      const cornerY = Math.max(0, radius - nearestY);
      const inside = cornerX * cornerX + cornerY * cornerY <= radius * radius;
      const offset = (y * width + x) * 4;
      const shade = Math.round(52 - 30 * (x + y) / (width + height - 2));
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  }
  return electron.nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
}
async function startCoach(pane, stepAside, restore, dragBundleOverride, identityOwner = dragBundleOverride ? "service" : "host") {
  if (process.platform !== "darwin") return false;
  const url = PANES[pane];
  if (!url) return false;
  const bundle = dragBundleOverride || draggableBundlePath();
  const dragToAdd = !!dragBundleOverride || pane === "accessibility" || pane === "screenRecording" || pane === "fullDisk";
  if (destroyTimer) {
    clearTimeout(destroyTimer);
    destroyTimer = null;
  }
  endGrantWatch("new-coach");
  deferredStopReason = null;
  preparedDragIcon = dragToAdd && bundle ? bundleIcon() : null;
  preparedDragBundle = dragToAdd && bundle ? bundle : null;
  if (dragToAdd && (!bundle || !preparedDragIcon || preparedDragIcon.isEmpty())) {
    logCoach("prepare-failed", { pane, hasBundle: !!bundle, hasIcon: !!preparedDragIcon });
    return false;
  }
  logCoach("start", { pane, dragToAdd, bundleName: bundle ? path__namespace.basename(bundle) : null });
  if (dragToAdd) {
    restoreMainWindow = restore ?? null;
    stepAside?.();
  }
  await openPermissionPane(url);
  if (!dragToAdd) {
    stopCoach();
    return true;
  }
  const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  const { x: workX, y: workY, width, height } = display.workArea;
  const size = { width: 260, height: 220 };
  if (coach && !coach.isDestroyed()) coach.destroy();
  completedNativeDrag = false;
  droppedPane = pane;
  droppedIdentityOwner = identityOwner;
  watchGrantAfterCompletedDrag = permissionDragNeedsGrantWatch(pane, identityOwner);
  coach = new electron.BrowserWindow({
    ...size,
    // Over the System Settings window, not the desktop below it. Settings opens centred at roughly
    // 800x600, so its list occupies the middle of the screen; the coach sits just below centre —
    // on the sheet, under the drop target, close enough that the drag is a short deliberate move
    // rather than a trip across the display.
    x: workX + Math.round((width - size.width) / 2) + 140,
    y: workY + Math.round(height - size.height - 42),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A native drag must originate from an interactive WebContents. `showInactive` below keeps
    // System Settings frontmost until the person actually grabs the compact drag tile.
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path__namespace.join(__dirname, "../preload/index.js"),
      ...REQUIRED_WEB_PREFERENCES
    }
  });
  coach.setAlwaysOnTop(true, "screen-saver");
  coach.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  coach.webContents.on("did-fail-load", (_event, code, description) => {
    logCoach("load-failed", { code, description });
  });
  coach.webContents.on("render-process-gone", (_event, details) => {
    logCoach("renderer-gone", { reason: details.reason, exitCode: details.exitCode });
  });
  coach.on("unresponsive", () => logCoach("unresponsive"));
  coach.once("closed", () => {
    logCoach("closed");
    coach = null;
    preparedDragBundle = null;
    preparedDragIcon = null;
    const pendingPane = completedNativeDrag && watchGrantAfterCompletedDrag ? droppedPane : null;
    const pendingOwner = droppedIdentityOwner;
    completedNativeDrag = false;
    watchGrantAfterCompletedDrag = false;
    droppedPane = null;
    const restoreWindow = restoreMainWindow;
    restoreMainWindow = null;
    if (pendingPane) {
      beginGrantWatch(pendingPane, pendingOwner, restoreWindow);
      return;
    }
    restoreWindow?.();
  });
  const route = "permission-coach";
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      await coach.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`);
    } else {
      await coach.loadFile(path__namespace.join(__dirname, "../renderer/index.html"), { hash: route });
    }
  } catch (error) {
    logCoach("load-threw", { error: error instanceof Error ? error.message : String(error) });
    stopCoach("load-threw");
    return false;
  }
  coach.showInactive();
  logCoach("shown", { webContentsId: coach.webContents.id });
  return true;
}
function setCoachInteractive(interactive) {
  if (!coach || coach.isDestroyed()) return;
}
function startBundleDrag(event) {
  const bundle = preparedDragBundle;
  if (!bundle || !preparedDragIcon || preparedDragIcon.isEmpty()) return false;
  nativeDragActive = true;
  logCoach("drag-started", { bundleName: path__namespace.basename(bundle) });
  try {
    event.sender.startDrag({ file: bundle, icon: preparedDragIcon });
    completedNativeDrag = true;
    return true;
  } catch (error) {
    logCoach("drag-failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    nativeDragActive = false;
    logCoach("drag-ended");
    if (deferredStopReason) {
      const reason = deferredStopReason;
      deferredStopReason = null;
      scheduleCoachDestruction(reason);
    } else {
      scheduleCoachDestruction("drag-completed");
    }
  }
}
function coachWebContentsId() {
  return coach && !coach.isDestroyed() ? coach.webContents.id : null;
}
function coachBundlePath() {
  return preparedDragBundle || draggableBundlePath() || "";
}
function clearCoachState() {
  coach = null;
  preparedDragBundle = null;
  preparedDragIcon = null;
  const pendingPane = completedNativeDrag && watchGrantAfterCompletedDrag ? droppedPane : null;
  const pendingOwner = droppedIdentityOwner;
  completedNativeDrag = false;
  watchGrantAfterCompletedDrag = false;
  droppedPane = null;
  const restoreWindow = restoreMainWindow;
  restoreMainWindow = null;
  if (pendingPane) {
    beginGrantWatch(pendingPane, pendingOwner, restoreWindow);
    return;
  }
  restoreWindow?.();
}
function scheduleCoachDestruction(reason) {
  if (!coach || coach.isDestroyed()) {
    clearCoachState();
    return;
  }
  coach.hide();
  if (destroyTimer) clearTimeout(destroyTimer);
  logCoach("destroy-scheduled", { reason, settleMs: DRAG_SETTLE_MS });
  destroyTimer = setTimeout(() => {
    destroyTimer = null;
    if (coach && !coach.isDestroyed()) coach.destroy();
    else clearCoachState();
  }, DRAG_SETTLE_MS);
}
function stopCoach(reason = "requested") {
  logCoach("stop", {
    reason,
    hasWindow: !!coach && !coach.isDestroyed(),
    nativeDragActive,
    awaitingGrant: !!grantWatch
  });
  if (reason === "before-quit") {
    endGrantWatch("before-quit");
    completedNativeDrag = false;
    watchGrantAfterCompletedDrag = false;
    droppedPane = null;
  } else if (grantWatch) {
    endGrantWatch(reason, "restore");
  }
  if (coach && !coach.isDestroyed()) {
    coach.hide();
    if (reason === "before-quit") {
      if (destroyTimer) clearTimeout(destroyTimer);
      destroyTimer = null;
      coach.destroy();
    } else if (nativeDragActive) {
      deferredStopReason = reason;
      logCoach("stop-deferred", { reason });
    } else {
      scheduleCoachDestruction(reason);
    }
    return;
  }
  clearCoachState();
}
electron.app.on("before-quit", () => stopCoach("before-quit"));
const DIR_MODE = 448;
const FILE_MODE = 384;
const CDHASH_PATTERN = /^[0-9a-f]{40,64}$/;
function breakglassDir() {
  return process.env.BIMAX_BREAKGLASS_DIR || path__namespace.join(os__namespace.homedir(), ".breakglass");
}
function adHocApprovalStorePath() {
  return path__namespace.join(breakglassDir(), "computer-service-approval.json");
}
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function unsafeFileReason(file) {
  if (isSymlink(path__namespace.dirname(file))) {
    return `${path__namespace.dirname(file)} is a symlink — refusing to read an approval through a redirected directory`;
  }
  if (isSymlink(file)) {
    return `${file} is a symlink, not a regular file — refusing to follow it`;
  }
  let info;
  try {
    info = fs.statSync(file);
  } catch {
    return void 0;
  }
  if (!info.isFile()) return `${file} is not a regular file`;
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (uid !== void 0 && info.uid !== uid) {
    return `${file} is owned by uid ${info.uid}, not by you (uid ${uid}) — refusing an approval another account could have written`;
  }
  if (uid !== void 0 && (info.mode & 18) !== 0) {
    return `${file} is writable by group or others (mode ${(info.mode & 511).toString(8)}) — refusing an approval another account could have planted; delete it and re-approve`;
  }
  return void 0;
}
function validate(value) {
  if (!value || typeof value !== "object") return void 0;
  const record = value;
  const hash = String(record.codeDirectoryHash || "").trim().toLowerCase();
  if (!CDHASH_PATTERN.test(hash)) return void 0;
  return {
    codeDirectoryHash: hash,
    approvedAt: typeof record.approvedAt === "string" ? record.approvedAt : "",
    ...typeof record.serviceVersion === "string" ? { serviceVersion: record.serviceVersion } : {},
    ...typeof record.binary === "string" ? { binary: record.binary } : {}
  };
}
let cache = null;
function cacheKey(file) {
  try {
    const s = fs.statSync(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.mode}:${s.uid}`;
  } catch {
    return "absent";
  }
}
function readAdHocServiceApproval() {
  const file = adHocApprovalStorePath();
  const key = `${file}\0${cacheKey(file)}`;
  if (cache && cache.key === key) return cache.result;
  const result = (() => {
    const unsafe = unsafeFileReason(file);
    if (unsafe) return { refusedReason: unsafe };
    let raw;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return {};
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { refusedReason: `${file} is not valid JSON — delete it and re-approve` };
    }
    const approval = validate(parsed);
    if (!approval) return { refusedReason: `${file} does not contain a usable code directory hash — delete it and re-approve` };
    return { approval };
  })();
  cache = { key, result };
  return result;
}
function currentAdHocServiceApproval() {
  return readAdHocServiceApproval().approval;
}
function recordAdHocServiceApproval(approval, now = () => /* @__PURE__ */ new Date()) {
  const file = adHocApprovalStorePath();
  const hash = String(approval.codeDirectoryHash || "").trim().toLowerCase();
  if (!CDHASH_PATTERN.test(hash)) {
    return { ok: false, path: file, error: `refusing to record "${approval.codeDirectoryHash}" — not a code directory hash` };
  }
  const dir = path__namespace.dirname(file);
  if (isSymlink(dir) || isSymlink(file)) {
    return { ok: false, path: file, error: `${isSymlink(dir) ? dir : file} is a symlink — refusing to write an approval through it` };
  }
  const record = {
    codeDirectoryHash: hash,
    approvedAt: now().toISOString(),
    ...approval.serviceVersion ? { serviceVersion: approval.serviceVersion } : {},
    ...approval.binary ? { binary: approval.binary } : {}
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}
`, { mode: FILE_MODE });
    fs.renameSync(temp, file);
    cache = null;
    return { ok: true, path: file };
  } catch (error) {
    cache = null;
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) };
  }
}
function revokeAdHocServiceApproval() {
  const file = adHocApprovalStorePath();
  try {
    fs.rmSync(file, { force: true });
    cache = null;
    return { ok: true, path: file };
  } catch (error) {
    cache = null;
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) };
  }
}
function runHandshake(binary) {
  return new Promise((resolve, reject) => {
    node_child_process.execFile(
      binary,
      ["--self-test-handshake"],
      { timeout: 3e3, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "native service probe failed").trim()));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("native service returned a malformed handshake"));
        }
      }
    );
  });
}
const HASH = /^[0-9a-f]{40,64}$/;
async function inspectManualAlphaService(binary) {
  if (process.platform !== "darwin" || !binary) {
    return {
      state: "unavailable",
      ready: false,
      canApprove: false,
      detail: process.platform === "darwin" ? "The Computer Use service is not present in this build." : "Computer Use service trust is available on macOS only."
    };
  }
  try {
    const handshake = await runHandshake(binary);
    const permissions = handshake.permissions ?? {};
    const serviceVersion = typeof handshake.serviceVersion === "string" ? handshake.serviceVersion : void 0;
    const servicePermissions = {
      accessibility: String(permissions.accessibility || "unknown"),
      screenRecording: String(permissions.screenRecording || "unknown")
    };
    if (permissions.serviceSigned === true) {
      return {
        state: "developer-id",
        ready: true,
        canApprove: false,
        serviceVersion,
        binary,
        permissions: servicePermissions,
        detail: "The Computer Use service has a production signing identity."
      };
    }
    const codeDirectoryHash = typeof permissions.codeDirectoryHash === "string" ? permissions.codeDirectoryHash.trim().toLowerCase() : "";
    const approval = currentAdHocServiceApproval();
    const base = {
      serviceVersion,
      binary,
      permissions: servicePermissions,
      ...HASH.test(codeDirectoryHash) ? { codeDirectoryHash } : {},
      ...approval ? {
        approvedHash: approval.codeDirectoryHash,
        approvedAt: approval.approvedAt
      } : {}
    };
    if (permissions.adHocSigned !== true || !HASH.test(codeDirectoryHash)) {
      return {
        ...base,
        state: "invalid",
        ready: false,
        canApprove: false,
        detail: "The service has no verifiable ad-hoc seal, so Bimax will not run it."
      };
    }
    if (permissions.signatureIntact !== true) {
      return {
        ...base,
        state: "invalid",
        ready: false,
        canApprove: false,
        detail: "The service changed after it was sealed. Rebuild it before approving anything."
      };
    }
    if (approval?.codeDirectoryHash.toLowerCase() === codeDirectoryHash) {
      return {
        ...base,
        state: "approved-ad-hoc",
        ready: true,
        canApprove: false,
        detail: "This exact ad-hoc-signed service is approved for local development."
      };
    }
    return {
      ...base,
      state: "approval-required",
      ready: false,
      canApprove: true,
      detail: approval ? "The service changed since the last approval. Review and approve the new exact hash." : "Developer ID is unavailable. Approve this exact local build to use Computer Use."
    };
  } catch (error) {
    return {
      state: "unavailable",
      ready: false,
      canApprove: false,
      binary,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
async function approveManualAlphaService(binary, expectedHash) {
  const before = await inspectManualAlphaService(binary);
  const expected = expectedHash.trim().toLowerCase();
  if (!before.canApprove || !before.codeDirectoryHash || before.codeDirectoryHash !== expected) {
    return {
      ...before,
      ready: false,
      detail: "The running service no longer matches the hash shown for approval. Refresh and review it again."
    };
  }
  const written = recordAdHocServiceApproval({
    codeDirectoryHash: before.codeDirectoryHash,
    serviceVersion: before.serviceVersion,
    binary: before.binary
  });
  if (!written.ok) return { ...before, detail: written.error || "Could not record the approval." };
  return inspectManualAlphaService(binary);
}
async function revokeManualAlphaService(binary) {
  const removed = revokeAdHocServiceApproval();
  if (!removed.ok) {
    const status = await inspectManualAlphaService(binary);
    return { ...status, detail: removed.error || "Could not revoke the approval." };
  }
  return inspectManualAlphaService(binary);
}
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{3,255}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_LEASE_MS = 5e3;
const RETURN_GRANT_MS = 6e4;
const MAX_BODY_BYTES = 8 * 1024;
function tokenMatches(expected, candidate) {
  if (typeof candidate !== "string" || !TOKEN.test(candidate)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(candidate, "hex");
  return a.length === b.length && node_crypto.timingSafeEqual(a, b);
}
class FocusActivationArbiter {
  constructor(token, options) {
    this.token = token;
    this.options = options;
  }
  seen = /* @__PURE__ */ new Map();
  returnGrantUntil = 0;
  async handle(raw) {
    const now = this.options.now?.() ?? Date.now();
    for (const [id, expires] of this.seen) if (expires < now) this.seen.delete(id);
    if (!raw || raw.version !== 1 || !tokenMatches(this.token, raw.token) || !REQUEST_ID.test(String(raw.requestId || "")) || !Number.isSafeInteger(raw.targetPid) || raw.targetPid <= 0 || !BUNDLE_ID.test(String(raw.targetBundleId || "")) || !Number.isFinite(raw.expiresAtMs) || raw.expiresAtMs < now || raw.expiresAtMs > now + MAX_LEASE_MS || this.seen.has(raw.requestId)) {
      return { accepted: false, code: "invalid_request" };
    }
    const returning = raw.targetPid === this.options.bimaxPid;
    if (returning) {
      if (this.returnGrantUntil < now) return { accepted: false, code: "return_grant_required" };
      this.returnGrantUntil = 0;
    } else {
      if (!this.options.isBimaxFocused()) return { accepted: false, code: "bimax_not_frontmost" };
      this.returnGrantUntil = now + RETURN_GRANT_MS;
    }
    this.seen.set(raw.requestId, raw.expiresAtMs);
    try {
      const activated = await this.options.activateBundle(raw.targetBundleId, raw.targetPid);
      return activated ? { accepted: true, code: "accepted" } : { accepted: false, code: "activation_failed" };
    } catch {
      return { accepted: false, code: "activation_failed" };
    }
  }
}
async function startFocusActivationBroker(options) {
  const token = node_crypto.randomBytes(32).toString("hex");
  const arbiter = new FocusActivationArbiter(token, options);
  let server;
  server = node_http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "POST" || request.url !== "/v1/focus/activate") {
      response.statusCode = 404;
      response.end(JSON.stringify({ accepted: false, code: "invalid_request" }));
      return;
    }
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ accepted: false, code: "invalid_request" }));
        return;
      }
      void arbiter.handle(body).then((result) => {
        response.statusCode = 200;
        response.end(JSON.stringify(result));
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error("focus broker did not receive a loopback port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/focus/activate`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
function launchExactProcessWithNativeHelper(activatorBinary, bundleId, pid, _hidePid) {
  if (!activatorBinary || !BUNDLE_ID.test(bundleId) || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    node_child_process.execFile(
      activatorBinary,
      ["--request-front-process", String(pid), bundleId],
      { timeout: 3e3, maxBuffer: 64 * 1024 },
      (error) => resolve(!error)
    );
  });
}
function hashSignals(signals) {
  return `sha256:${node_crypto.createHash("sha256").update(JSON.stringify(signals)).digest("hex")}`;
}
class AdaptiveRuntimePolicy {
  current = 2;
  lastChangedAt = Number.NEGATIVE_INFINITY;
  lastInteractionAt = Number.NEGATIVE_INFINITY;
  now;
  thresholds;
  canaryEnabled;
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.thresholds = {
      minimumResidenceMs: options.minimumResidenceMs ?? 3e4,
      interactionCooldownMs: options.interactionCooldownMs ?? 2e3,
      minimumHeadroomMb: options.minimumHeadroomMb ?? 1536
    };
    this.canaryEnabled = options.canaryEnabled === true;
  }
  decide(signals) {
    const now = this.now();
    if (signals.activeInteraction) this.lastInteractionAt = now;
    const reasons = [];
    const reserved = Math.max(0, signals.simulatorReservationMb) + Math.max(0, signals.localModelReservationMb);
    const headroom = signals.availableMemoryMb - reserved;
    let desired = Math.max(1, Math.min(4, Math.floor(Math.max(1, signals.cpuCount) / 2)));
    if (signals.activeInteraction || now - this.lastInteractionAt < this.thresholds.interactionCooldownMs) {
      desired = 1;
      reasons.push("Active interaction has priority over new background work.");
    }
    if (signals.memoryPressure === "critical" || headroom < this.thresholds.minimumHeadroomMb) {
      desired = 1;
      reasons.push("Memory headroom is below the safe background-work floor.");
    } else if (signals.memoryPressure === "warning") {
      desired = Math.min(desired, 2);
      reasons.push("Memory pressure is elevated.");
    }
    if (signals.thermal === "critical" || signals.thermal === "serious") {
      desired = 1;
      reasons.push(`Thermal state is ${signals.thermal}.`);
    } else if (signals.thermal === "fair") {
      desired = Math.min(desired, 2);
      reasons.push("Thermal state is fair.");
    }
    if (signals.lowPowerMode === true || signals.powerSource === "battery") {
      desired = Math.min(desired, signals.lowPowerMode ? 1 : 2);
      reasons.push(signals.lowPowerMode === true ? "Low Power Mode is enabled." : "The Mac is on battery power.");
    }
    if (signals.memoryPressure === "unknown" || signals.thermal === "unknown") {
      desired = Math.min(desired, 2);
      reasons.push("A required system signal is unknown, so policy uses a bounded default.");
    }
    desired = Math.max(1, Math.min(4, desired));
    const constraining = desired < this.current;
    const mayRelax = now - this.lastChangedAt >= this.thresholds.minimumResidenceMs;
    const next = this.canaryEnabled && (constraining || mayRelax) ? desired : this.current;
    const changed = next !== this.current;
    const previous = this.current;
    if (changed) {
      this.current = next;
      this.lastChangedAt = now;
    }
    if (!this.canaryEnabled) reasons.push("The background-concurrency policy is in shadow mode.");
    if (this.canaryEnabled && desired > this.current && !mayRelax) reasons.push("Hysteresis held the prior limit until minimum residence time expires.");
    return {
      decisionClass: "background-concurrency",
      policyVersion: "bimax-adaptive/1",
      snapshotHash: hashSignals(signals),
      previous,
      selected: this.current,
      automatic: this.canaryEnabled,
      changed,
      reasons: reasons.length ? reasons : ["System capacity is inside the measured baseline."],
      thresholds: { ...this.thresholds },
      expiresAt: now + 6e4
    };
  }
  engineEnvironment(decision) {
    if (!decision.automatic) return {};
    return {
      BIMAX_MAX_CONCURRENT_SUBAGENTS: String(decision.selected),
      BIMAX_POWER_AWARE: "1",
      BIMAX_POWER_SOFT_SUBAGENTS: String(decision.selected)
    };
  }
}
function renderingPolicy(signals, canaryEnabled = false) {
  if (signals.reduceMotion) {
    return {
      mode: "reduced-motion",
      preferredFps: 30,
      nonessentialAnimation: false,
      automatic: true,
      reasons: ["Reduce Motion is a hard accessibility constraint."]
    };
  }
  const quiet = signals.activeInteraction || signals.lowPowerMode === true || signals.thermal === "serious" || signals.thermal === "critical" || signals.memoryPressure === "critical";
  return {
    mode: quiet ? "quiet" : "full",
    preferredFps: quiet ? 30 : 60,
    // Rendering remains observe-only until a real frame/energy matrix proves a win.
    nonessentialAnimation: canaryEnabled ? !quiet : true,
    automatic: canaryEnabled,
    reasons: [quiet ? "The measured runtime signals recommend quiet rendering." : "Runtime signals allow full rendering.", ...canaryEnabled ? [] : ["Rendering adaptation remains in shadow mode."]]
  };
}
const execFileAsync = node_util.promisify(node_child_process.execFile);
const PROBES = Object.freeze([
  { id: "node", label: "Node.js", category: "runtime", command: "node", args: ["--version"] },
  { id: "python3", label: "Python", category: "runtime", command: "python3", args: ["--version"] },
  { id: "swift", label: "Swift", category: "runtime", command: "swift", args: ["--version"] },
  { id: "git", label: "Git", category: "runtime", command: "git", args: ["--version"] },
  { id: "npm", label: "npm", category: "package-manager", command: "npm", args: ["--version"] },
  { id: "pnpm", label: "pnpm", category: "package-manager", command: "pnpm", args: ["--version"] },
  { id: "bun", label: "Bun", category: "package-manager", command: "bun", args: ["--version"] },
  { id: "uv", label: "uv", category: "package-manager", command: "uv", args: ["--version"] },
  { id: "brew", label: "Homebrew", category: "package-manager", command: "brew", args: ["--version"] },
  { id: "xcodebuild", label: "Xcode", category: "sdk", command: "xcodebuild", args: ["-version"] },
  { id: "docker", label: "Docker", category: "service", command: "docker", args: ["--version"] },
  { id: "ollama", label: "Ollama", category: "ml", command: "ollama", args: ["--version"] },
  { id: "llama.cpp", label: "llama.cpp", category: "ml", command: "llama-cli", args: ["--version"] }
]);
const DECLARATIONS = Object.freeze([
  { file: "package.json", ecosystem: "Node" },
  { file: "package-lock.json", ecosystem: "Node" },
  { file: "pnpm-lock.yaml", ecosystem: "Node" },
  { file: "yarn.lock", ecosystem: "Node" },
  { file: "bun.lock", ecosystem: "Node" },
  { file: "pyproject.toml", ecosystem: "Python" },
  { file: "uv.lock", ecosystem: "Python" },
  { file: "requirements.txt", ecosystem: "Python" },
  { file: "Package.swift", ecosystem: "Swift" },
  { file: "Cargo.toml", ecosystem: "Rust" },
  { file: "go.mod", ecosystem: "Go" },
  { file: "Dockerfile", ecosystem: "Containers" },
  { file: "docker-compose.yml", ecosystem: "Containers" },
  { file: ".nvmrc", ecosystem: "Node" },
  { file: ".python-version", ecosystem: "Python" },
  { file: ".tool-versions", ecosystem: "Toolchains" }
]);
function firstVersion(text) {
  return text.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
}
async function executablePath(command) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [command], {
      timeout: 2e3,
      maxBuffer: 16 * 1024,
      encoding: "utf8"
    });
    const value = stdout.trim().split("\n")[0];
    return value.startsWith("/") ? value : null;
  } catch {
    return null;
  }
}
async function probeTool(probe2) {
  const executable = await executablePath(probe2.command);
  if (!executable) {
    return {
      id: probe2.id,
      label: probe2.label,
      category: probe2.category,
      state: "missing",
      version: null,
      executable: null,
      note: "Not found on the app runtime PATH."
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, probe2.args, {
      timeout: 3e3,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" }
    });
    const output = `${stdout}
${stderr}`.trim();
    return {
      id: probe2.id,
      label: probe2.label,
      category: probe2.category,
      state: "ready",
      version: firstVersion(output),
      executable,
      note: output.split("\n")[0]?.slice(0, 180) || "Version probe completed."
    };
  } catch (error) {
    return {
      id: probe2.id,
      label: probe2.label,
      category: probe2.category,
      state: "unverified",
      version: null,
      executable,
      note: error instanceof Error ? error.message.slice(0, 180) : "The fixed version probe failed."
    };
  }
}
async function mapLimited(values, limit, fn) {
  const output = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}
async function declarations(projectRoot) {
  const found = await Promise.all(DECLARATIONS.map(async (entry) => {
    try {
      await promises.access(path.join(projectRoot, entry.file));
      return entry;
    } catch {
      return null;
    }
  }));
  return found.filter((entry) => entry !== null);
}
async function inspectEnvironmentCapabilities(projectRoot) {
  const [projectDeclarations, tools] = await Promise.all([
    declarations(projectRoot),
    mapLimited(PROBES, 4, probeTool)
  ]);
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    projectName: path.basename(projectRoot),
    declarations: projectDeclarations,
    tools,
    safety: { mutating: false, sourcedShellProfiles: false, executedProjectScripts: false }
  };
}
async function pythonPackageVersion(packageName) {
  const python = await executablePath("python3");
  if (!python) return null;
  const program = [
    "import importlib.metadata as m",
    `name=${JSON.stringify(packageName)}`,
    "try: print(m.version(name))",
    "except m.PackageNotFoundError: pass"
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(python, ["-I", "-c", program], {
      timeout: 3e3,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" }
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function inspectAlchemistCapabilities(environment) {
  const tools = environment?.tools ?? await mapLimited(PROBES, 4, probeTool);
  const [mlx, coremltools] = await Promise.all([
    pythonPackageVersion("mlx"),
    pythonPackageVersion("coremltools")
  ]);
  const llama = tools.find((tool) => tool.id === "llama.cpp");
  const ollama = tools.find((tool) => tool.id === "ollama");
  const backends = [
    { id: "mlx", label: "MLX", role: "Apple-silicon research, fine-tuning and generation", state: mlx ? "ready" : "missing", version: mlx },
    { id: "coremltools", label: "Core ML Tools", role: "Conversion, pruning, palettization and deployment", state: coremltools ? "ready" : "missing", version: coremltools },
    { id: "llama.cpp", label: "llama.cpp", role: "GGUF quantization and local Metal inference", state: llama?.state ?? "missing", version: llama?.version ?? null },
    { id: "ollama", label: "Ollama", role: "Optional local model serving", state: ollama?.state ?? "missing", version: ollama?.version ?? null }
  ];
  const hasResearch = Boolean(mlx);
  const hasDeployment = Boolean(coremltools);
  const hasLocalInference = llama?.state === "ready" || ollama?.state === "ready";
  const readyCount = backends.filter((backend) => backend.state === "ready").length;
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    state: hasResearch && hasDeployment ? "ready" : readyCount > 0 ? "partial" : "unavailable",
    backends,
    workflows: [
      { id: "inspect", label: "Inspect architecture", available: hasResearch || hasDeployment || hasLocalInference, detail: "Read format, parameter graph, size, provenance and compatibility before loading." },
      { id: "quantize", label: "Quantize & compress", available: hasResearch || hasDeployment || llama?.state === "ready", detail: "Compare named INT4/INT8, palettization or GGUF candidates against the baseline." },
      { id: "fine-tune", label: "LoRA / QLoRA experiment", available: hasResearch, detail: "Requires MLX plus a declared dataset and reproducibility contract." },
      { id: "compare", label: "Compare candidates", available: hasResearch || hasDeployment || hasLocalInference, detail: "Quality, behavior, latency, memory, size, energy proxy and device support." },
      { id: "export", label: "Verify & export", available: hasDeployment || llama?.state === "ready", detail: "Export only a candidate whose digest and evaluation contract pass." }
    ],
    boundary: "Backends run in isolated workers over immutable artifact handles. Pickle input and in-place checkpoint mutation are refused."
  };
}
const PROVIDER_ENV = {
  nvidia: "NVIDIA_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GOOGLE_API_KEY"
};
let loaded = false;
let activeProvider = "";
let activeBaseURL = "";
const keys = /* @__PURE__ */ new Map();
function storePath() {
  return path.join(electron.app.getPath("userData"), "provider-credentials.v1.json");
}
function assertProvider(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!PROVIDER_ENV[normalized]) throw new Error(`Unsupported provider "${name}".`);
  return normalized;
}
function keyHint(value) {
  return value.length >= 12 ? `…${value.slice(-4)}` : void 0;
}
function loadProviderCredentials() {
  if (loaded) return;
  loaded = true;
  const file = storePath();
  if (!node_fs.existsSync(file)) return;
  try {
    const stored = JSON.parse(node_fs.readFileSync(file, "utf8"));
    if (stored.version !== 1 || !stored.encrypted || typeof stored.encrypted !== "object") return;
    activeProvider = PROVIDER_ENV[String(stored.activeProvider || "")] ? String(stored.activeProvider) : "";
    activeBaseURL = typeof stored.baseURL === "string" ? stored.baseURL : "";
    const encrypted = Object.entries(stored.encrypted).filter(([name, encoded]) => !!PROVIDER_ENV[name] && typeof encoded === "string");
    if (encrypted.length === 0) return;
    if (!electron.safeStorage.isEncryptionAvailable()) return;
    for (const [name, encoded] of encrypted) {
      if (!PROVIDER_ENV[name] || typeof encoded !== "string") continue;
      const value = electron.safeStorage.decryptString(Buffer.from(encoded, "base64")).trim();
      if (value) keys.set(name, value);
    }
  } catch {
    keys.clear();
    activeProvider = "";
    activeBaseURL = "";
  }
}
function persist() {
  if (!electron.safeStorage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain is unavailable. Bimax did not save the API key.");
  }
  const file = storePath();
  node_fs.mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
  try {
    node_fs.chmodSync(path.dirname(file), 448);
  } catch {
  }
  const encrypted = {};
  for (const [name, value] of keys) {
    encrypted[name] = electron.safeStorage.encryptString(value).toString("base64");
  }
  const payload = {
    version: 1,
    ...activeProvider ? { activeProvider } : {},
    ...activeBaseURL ? { baseURL: activeBaseURL } : {},
    encrypted
  };
  const tmp = `${file}.tmp`;
  node_fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}
`, { encoding: "utf8", mode: 384 });
  try {
    node_fs.chmodSync(tmp, 384);
  } catch {
  }
  node_fs.renameSync(tmp, file);
}
function configureProviderCredential(input) {
  loadProviderCredentials();
  const name = assertProvider(input.name);
  const apiKey = String(input.apiKey || "").trim();
  const baseURL = String(input.baseURL || "").trim();
  if (apiKey && (apiKey.length < 8 || apiKey.length > 8192)) throw new Error("The API key length is invalid.");
  if (baseURL && !/^https:\/\/[^\s]+$/i.test(baseURL)) throw new Error("Custom provider endpoints must use HTTPS.");
  if (apiKey) keys.set(name, apiKey);
  activeProvider = name;
  activeBaseURL = baseURL;
  persist();
}
function providerCredentialEnvironment() {
  loadProviderCredentials();
  const env = {};
  for (const [name, value] of keys) env[PROVIDER_ENV[name]] = value;
  if (activeProvider) env.BIMAX_DESKTOP_PROVIDER = activeProvider;
  if (activeBaseURL) env.BIMAX_DESKTOP_PROVIDER_BASE_URL = activeBaseURL;
  return env;
}
function providerCredentialStatuses() {
  loadProviderCredentials();
  return Object.keys(PROVIDER_ENV).map((name) => {
    const value = keys.get(name) || "";
    return {
      name,
      hasKey: !!value,
      ...value ? { keyHint: keyHint(value) } : {},
      storage: value ? "keychain" : "none",
      active: name === activeProvider
    };
  });
}
let win = null;
let supervisor = null;
let projectWatcher = null;
let lastStatus = null;
let latestUiSnapshot = null;
let latestReviewSnapshot = null;
let focusBroker = null;
const takeover = new UserTakeoverAuthority();
let takeoverBroker = null;
let takeoverBrokerError = null;
const adaptivePolicy = new AdaptiveRuntimePolicy({
  canaryEnabled: process.env.BIMAX_ADAPTIVE_CONCURRENCY !== "off"
});
let thermalState = "unknown";
let lastInteractionAt = Number.NEGATIVE_INFINITY;
let reduceMotion = false;
let capabilityCache = null;
async function workspaceCapabilities() {
  const project = projectDir();
  if (!project) return null;
  if (capabilityCache && capabilityCache.project === project && Date.now() - capabilityCache.at < 3e4) {
    return capabilityCache;
  }
  const environment = await inspectEnvironmentCapabilities(project);
  const alchemist = await inspectAlchemistCapabilities(environment);
  capabilityCache = { project, at: Date.now(), environment, alchemist };
  return { environment, alchemist };
}
const ownsSingleInstance = electron.app.requestSingleInstanceLock();
if (!ownsSingleInstance) electron.app.quit();
function revealMainWindow() {
  if (coachWebContentsId() !== null) return;
  if (isAwaitingHostGrant()) return;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  if (electron.app.isReady()) createWindow();
}
electron.app.on("second-instance", revealMainWindow);
function currentRuntimeSignals() {
  const totalMb = os.totalmem() / (1024 * 1024);
  const availableMemoryMb = Math.max(0, Math.round(os.freemem() / (1024 * 1024)));
  const freeRatio = totalMb > 0 ? availableMemoryMb / totalMb : 0;
  return {
    observedAt: Date.now(),
    architecture: process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unknown",
    cpuCount: os.cpus().length,
    availableMemoryMb,
    thermal: thermalState,
    memoryPressure: freeRatio < 0.05 ? "critical" : freeRatio < 0.12 ? "warning" : "normal",
    powerSource: electron.powerMonitor.isOnBatteryPower() ? "battery" : "ac",
    // Electron has no stable Low Power Mode query. Unknown is explicit; battery state still feeds
    // the bounded controller and the native layer can add the signal later.
    lowPowerMode: null,
    network: electron.net.isOnline() ? "unknown" : "offline",
    activeInteraction: Date.now() - lastInteractionAt < 2e3,
    reduceMotion,
    simulatorReservationMb: 0,
    localModelReservationMb: 0
  };
}
function adaptiveSnapshot() {
  const signals = currentRuntimeSignals();
  const decision = adaptivePolicy.decide(signals);
  return { signals, decision, rendering: renderingPolicy(signals, false) };
}
function broadcast(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function accentColour() {
  try {
    const raw = electron.systemPreferences.getAccentColor?.();
    if (!raw || raw.length < 6) return null;
    return `#${raw.slice(0, 6).toLowerCase()}`;
  } catch {
    return null;
  }
}
function windowChrome() {
  if (!win || win.isDestroyed()) {
    return { fullScreen: false, maximized: false, active: true, accent: null };
  }
  return {
    fullScreen: win.isFullScreen(),
    maximized: win.isMaximized(),
    // AppKit's `appearsActive` (Prompt 2 §15). A Mac app that looks identical whether or not it is
    // the key window is the tell that its chrome is drawn rather than native — but the correction
    // is a subtle one, and lives in CSS, because "not focused" must never mean "hard to read".
    active: win.isFocused(),
    accent: accentColour()
  };
}
function permissionJourneyWindowMoves() {
  let wasHidden = false;
  return {
    stepAside: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isFullScreen()) {
        wasHidden = false;
        return;
      }
      wasHidden = true;
      win.hide();
    },
    restore: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (wasHidden) win.show();
      win.focus();
      electron.app.focus({ steal: true });
    }
  };
}
function trustedRenderer() {
  const coachId = coachWebContentsId();
  return {
    webContentsId: win && !win.isDestroyed() ? win.webContents.id : null,
    // The drag coach is our own window and needs the same door; without this its bundle lookup,
    // click-through hand-off and drag are all refused, which looks exactly like "nothing to drag".
    auxiliaryWebContentsIds: coachId === null ? [] : [coachId],
    devServerUrl: process.env.ELECTRON_RENDERER_URL
  };
}
function senderIdentity(event) {
  const frame = event.senderFrame;
  return {
    senderId: event.sender.id,
    // A frame that has already been destroyed throws on .url; treat that as untrusted.
    frameUrl: (() => {
      try {
        return frame?.url;
      } catch {
        return void 0;
      }
    })(),
    isMainFrame: !!frame && frame === frame.top
  };
}
function refuse(channel, reason) {
  console.error(`[ipc] refused ${channel}: ${reason}`);
}
const evidenceStore = new DesktopEvidenceStore();
function secureHandle(channel, fallback, fn) {
  electron.ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(senderIdentity(event), trustedRenderer())) {
      refuse(channel, "untrusted sender");
      return fallback;
    }
    try {
      return await fn(event, ...args);
    } catch (error) {
      if (error instanceof InvalidPayloadError) {
        refuse(channel, error.message);
        return fallback;
      }
      throw error;
    }
  });
}
function secureOn(channel, fn) {
  electron.ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(senderIdentity(event), trustedRenderer())) {
      refuse(channel, "untrusted sender");
      return;
    }
    try {
      fn(event, ...args);
    } catch (error) {
      if (error instanceof InvalidPayloadError) refuse(channel, error.message);
      else throw error;
    }
  });
}
function legacyState(s) {
  switch (s.phase) {
    case "idle":
      return null;
    case "ready":
    case "degraded":
      return { state: "ready", detail: s.message };
    case "exited":
    case "failed":
      return { state: "exited", detail: s.reason };
    default:
      return { state: "starting", detail: s.message };
  }
}
function createSupervisor() {
  const journalPath = path.join(electron.app.getPath("userData"), "crash-journal.json");
  const journal = new CrashJournal({
    load: () => {
      try {
        return node_fs.readFileSync(journalPath, "utf8");
      } catch {
        return null;
      }
    },
    save: (text) => {
      node_fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      const tmp = `${journalPath}.tmp`;
      node_fs.writeFileSync(tmp, text);
      node_fs.renameSync(tmp, journalPath);
    }
  });
  return new EngineSupervisor({
    spawn: (project, extraEnv, callbacks) => {
      const adaptive = adaptiveSnapshot();
      return spawnEngineProcess(project, {
        ...extraEnv,
        ...adaptivePolicy.engineEnvironment(adaptive.decision),
        // Keychain-backed secrets enter only at the child boundary. They never pass through the
        // renderer or the engine protocol and are not written to diagnostics.
        ...providerCredentialEnvironment()
      }, callbacks);
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    random: () => Math.random(),
    memory: () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }),
    env: process.env,
    journal,
    logTail: () => recentEngineLog(),
    onStatus: (status) => {
      lastStatus = status;
      broadcast("supervisor:status", status);
      const legacy = legacyState(status);
      if (legacy) broadcast("engine:state", legacy.state, legacy.detail);
    },
    onMessage: (msg) => {
      if (msg?.t === "event" && msg.name === "ui_snapshot") latestUiSnapshot = msg;
      if (msg?.t === "event" && msg.name === "review_update") latestReviewSnapshot = msg;
      broadcast("engine:msg", msg);
    },
    // Notices reuse the renderer's existing diagnostics pipeline (the 'log' event fold), so they
    // show up in the Health panel without a parallel plumbing path.
    onNotice: (level, text) => {
      broadcast("engine:msg", {
        t: "event",
        name: "log",
        args: [{ id: `sup-${Date.now()}`, level, text: `[supervisor] ${text}`, timestamp: (/* @__PURE__ */ new Date()).toISOString() }]
      });
    }
  });
}
function startEngine(projectDir2) {
  latestUiSnapshot = null;
  latestReviewSnapshot = null;
  capabilityCache = null;
  if (!supervisor) supervisor = createSupervisor();
  supervisor.openProject(projectDir2);
  projectWatcher?.close();
  projectWatcher = watchProject(projectDir2, () => broadcast("files:changed"));
  broadcast("app:project", projectDir2);
  recordProject(projectDir2);
}
function projectDir() {
  return supervisor?.currentProject ?? "";
}
async function currentTrustReport() {
  const darwin = process.platform === "darwin";
  const components = componentResolutions();
  const nativeServiceTrust = await inspectManualAlphaService(bimaxCuServiceBinary());
  const nativePermissionsReady = nativeServiceTrust.permissions?.accessibility === "granted" && nativeServiceTrust.permissions?.screenRecording === "granted";
  return buildTrustReport({
    now: () => /* @__PURE__ */ new Date(),
    build: {
      packaged: electron.app.isPackaged,
      appVersion: electron.app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      osRelease: os.release(),
      minimumMacOS: MINIMUM_MACOS
    },
    permissions: {
      // Fresh-child readings — see host.grants.ts. This is the gate the native Computer Use path
      // checks before it will route, so a stale negative here does not merely mislabel a row: it
      // keeps Bimax CU switched off after the user has already granted everything it asked for.
      accessibility: darwin ? hostGrants().accessibility : "unavailable",
      screenRecording: darwin ? hostGrants().screenRecording : "unavailable"
    },
    components,
    integrity: {
      app: inspectExecutable(process.execPath),
      components: Object.fromEntries(components.flatMap(({ name, resolution }) => resolution.path ? [[name, inspectExecutable(resolution.path)]] : []))
    },
    userTakeover: takeoverBroker ? { available: true } : {
      available: false,
      detail: `Bimax could not set up the control you would use to take over, so it will not act on your Mac${takeoverBrokerError ? ` (${takeoverBrokerError})` : ""}`
    },
    nativeServiceTrust: {
      ready: nativeServiceTrust.ready && nativePermissionsReady,
      detail: nativeServiceTrust.ready && !nativePermissionsReady ? "The native Computer Use service still needs its own Accessibility and Screen Recording grants." : nativeServiceTrust.detail
    }
  });
}
function createWindow() {
  win = new electron.BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Bimax",
    // Fully transparent, and deliberately so: macOS paints the vibrancy material *behind* the web
    // contents, so any opaque window background hides it completely. That is exactly why the
    // sidebar's `backdrop-filter` had nothing to sample but our own `--color-bg` and rendered as a
    // flat grey panel. The renderer keeps `body` transparent and paints every surface that is NOT
    // meant to be glass (see styles.css); this colour is only what shows before the first paint.
    backgroundColor: "#00000000",
    vibrancy: process.platform === "darwin" ? "sidebar" : void 0,
    visualEffectState: process.platform === "darwin" ? "active" : void 0,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      ...REQUIRED_WEB_PREFERENCES
    }
  });
  const sendChrome = () => {
    const chrome = windowChrome();
    if (process.platform === "darwin" && win && !win.isDestroyed()) {
      win.setVibrancy(chrome.fullScreen || chrome.maximized ? null : "sidebar");
    }
    broadcast("window:chrome", chrome);
  };
  win.on("enter-full-screen", sendChrome);
  win.on("leave-full-screen", sendChrome);
  win.on("maximize", sendChrome);
  win.on("unmaximize", sendChrome);
  win.on("restore", sendChrome);
  win.on("focus", sendChrome);
  win.on("blur", sendChrome);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, trustedRenderer())) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void electron.shell.openExternal(url);
    else refuse("will-navigate", url);
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    refuse("will-attach-webview", "webviews are not part of this product");
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.on("closed", () => {
    win = null;
  });
}
function hardenSession() {
  const ses = electron.session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const csp = devUrl ? `default-src 'self' ${devUrl}; script-src 'self' 'unsafe-eval' 'unsafe-inline' ${devUrl}; style-src 'self' 'unsafe-inline' ${devUrl}; img-src 'self' data: file: ${devUrl}; font-src 'self' data: ${devUrl}; connect-src 'self' ${devUrl} ws: http:; object-src 'none'; frame-src 'none'; worker-src 'self' blob:; base-uri 'none'; form-action 'none';` : RENDERER_CSP;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  });
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    refuse("permission-request", permission);
    callback(isAllowedPermission());
  });
  ses.setPermissionCheckHandler(() => isAllowedPermission());
}
electron.app.whenReady().then(async () => {
  hardenSession();
  loadProviderCredentials();
  if (process.platform === "darwin") {
    electron.powerMonitor.on("thermal-state-change", ({ state }) => {
      thermalState = state;
      broadcast("adaptive:changed", adaptiveSnapshot());
    });
  }
  supervisor = createSupervisor();
  try {
    takeoverBroker = await startUserTakeoverBroker(takeover);
    setTakeoverBrokerCredentials({ endpoint: takeoverBroker.endpoint, token: takeoverBroker.token });
  } catch (error) {
    takeoverBrokerError = String(error?.message || error);
    console.error("[takeover-broker] unavailable:", error);
  }
  if (process.platform === "darwin") {
    try {
      const activatorBinary = bimaxCuServiceBinary();
      if (!activatorBinary) throw new Error("native focus activator is not packaged");
      focusBroker = await startFocusActivationBroker({
        bimaxPid: process.pid,
        isBimaxFocused: () => !!win?.isFocused(),
        activateBundle: async (bundleId, pid) => {
          if (pid === process.pid) {
            electron.app.setActivationPolicy("regular");
            electron.app.show();
            win?.show();
            const activated = await launchExactProcessWithNativeHelper(
              activatorBinary,
              bundleId,
              pid
            );
            if (activated) win?.focus();
            return activated;
          }
          setImmediate(() => void (async () => {
            const activated = await launchExactProcessWithNativeHelper(
              activatorBinary,
              bundleId,
              pid,
              process.pid
            );
            if (activated) {
              electron.app.setActivationPolicy("accessory");
              win?.hide();
              electron.app.hide();
            }
          })());
          return true;
        }
      });
      process.env.BIMAX_CU_FOCUS_BROKER_ENDPOINT = focusBroker.endpoint;
      process.env.BIMAX_CU_FOCUS_BROKER_TOKEN = focusBroker.token;
    } catch (error) {
      console.error("[focus-broker] unavailable:", error);
    }
  }
  createWindow();
  const initialDir = pickInitialProject(loadSettings().lastProject);
  secureOn("engine:send", (_e, msg) => {
    if (!isProtocolFrame(msg)) throw new InvalidPayloadError("not a protocol frame");
    supervisor?.sendFromRenderer(msg);
  });
  secureHandle("app:pick-folder", null, async () => {
    if (!win) return null;
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Open Project",
      properties: ["openDirectory", "createDirectory"]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    startEngine(dir);
    return dir;
  });
  secureHandle("engine:restart", "", () => {
    const dir = supervisor?.currentProject || pickInitialProject(loadSettings().lastProject);
    if (dir) startEngine(dir);
    else broadcast("app:project", "");
    return supervisor?.currentProject ?? "";
  });
  secureHandle("providers:credential-status", [], () => providerCredentialStatuses());
  secureHandle("providers:configure", { ok: false }, (_e, raw) => {
    const request = raw;
    if (!request || typeof request.name !== "string") throw new InvalidPayloadError("provider name is required");
    if (request.apiKey !== void 0 && typeof request.apiKey !== "string") throw new InvalidPayloadError("provider key must be text");
    if (request.baseURL !== void 0 && typeof request.baseURL !== "string") throw new InvalidPayloadError("provider endpoint must be text");
    try {
      configureProviderCredential({
        name: request.name,
        ...request.apiKey ? { apiKey: request.apiKey } : {},
        ...request.baseURL ? { baseURL: request.baseURL } : {}
      });
      const dir = supervisor?.currentProject || pickInitialProject(loadSettings().lastProject);
      if (dir) startEngine(dir);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });
  secureHandle("supervisor:get-status", null, () => lastStatus ?? supervisor?.status() ?? null);
  secureHandle("supervisor:action", false, (_e, raw) => supervisor?.handleAction(asSupervisorAction(raw)) ?? false);
  secureHandle("supervisor:crash-history", [], () => supervisor?.crashHistory() ?? []);
  secureHandle("supervisor:diagnostics", "", () => supervisor?.diagnosticsText() ?? "");
  secureHandle("phase9:adaptive-state", null, () => adaptiveSnapshot());
  secureHandle("phase9:process-provenance", [], () => engineProcessProvenance());
  secureHandle("phase9:environment", null, async () => (await workspaceCapabilities())?.environment ?? null);
  secureHandle("phase9:alchemist-status", null, async () => (await workspaceCapabilities())?.alchemist ?? null);
  secureOn("phase9:interaction", (_e, raw) => {
    const payload = raw;
    if (!payload || typeof payload.active !== "boolean" || typeof payload.reduceMotion !== "boolean") {
      throw new InvalidPayloadError("not a runtime interaction signal");
    }
    if (payload.active) lastInteractionAt = Date.now();
    reduceMotion = payload.reduceMotion;
  });
  secureHandle("app:get-project", "", () => projectDir());
  secureHandle("trust:report", null, () => currentTrustReport());
  secureHandle("trust:manual-alpha-status", null, () => inspectManualAlphaService(bimaxCuServiceBinary()));
  secureHandle("trust:approve-manual-alpha", null, (_e, raw) => {
    if (typeof raw !== "string" || !/^[0-9a-f]{40,64}$/i.test(raw.trim())) {
      throw new InvalidPayloadError("manual-alpha approval requires an exact code directory hash");
    }
    return approveManualAlphaService(bimaxCuServiceBinary(), raw);
  });
  secureHandle("trust:revoke-manual-alpha", null, () => revokeManualAlphaService(bimaxCuServiceBinary()));
  secureHandle("trust:export-diagnostics", "failed", async () => {
    if (!win) return "failed";
    const selected = await electron.dialog.showSaveDialog(win, {
      title: "Export private Bimax diagnostics",
      defaultPath: `Bimax-diagnostics-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"]
    });
    if (selected.canceled || !selected.filePath) return "cancelled";
    const payload = buildDiagnosticExport({
      now: () => /* @__PURE__ */ new Date(),
      trust: await currentTrustReport(),
      status: lastStatus ?? supervisor?.status() ?? null,
      crashes: supervisor?.crashHistory() ?? []
    });
    const tmp = `${selected.filePath}.tmp-${process.pid}`;
    try {
      node_fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}
`, { mode: 384 });
      node_fs.renameSync(tmp, selected.filePath);
      return "saved";
    } catch (error) {
      console.error("[diagnostics] export failed:", error);
      return "failed";
    }
  });
  secureHandle("evidence:timeline", null, (_e, raw) => {
    const taskIntentId = typeof raw === "string" && raw ? raw : null;
    const records = taskIntentId ? evidenceStore.forTask(taskIntentId) : evidenceStore.all();
    return buildEvidenceTimeline(records, [...evidenceStore.evictionLog()]);
  });
  secureHandle("evidence:retention-controls", [], (_e, raw) => {
    const taskIntentId = typeof raw === "string" && raw ? raw : null;
    return retentionControls(evidenceStore.all(), taskIntentId);
  });
  secureHandle("evidence:delete", 0, (_e, raw) => {
    const request = raw;
    const scope = typeof request?.scope === "string" ? request.scope : "";
    if (scope === "task") {
      const taskIntentId = typeof request?.taskIntentId === "string" ? request.taskIntentId : "";
      if (!taskIntentId) throw new InvalidPayloadError('delete scope "task" needs a taskIntentId');
      return evidenceStore.deleteTask(taskIntentId);
    }
    if (scope === "observations") return evidenceStore.deleteObservations();
    if (scope === "all") return evidenceStore.deleteAll();
    throw new InvalidPayloadError("unknown evidence delete scope");
  });
  secureHandle("trust:open-permission-settings", false, async (_e, which) => {
    const panes = {
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    };
    const url = typeof which === "string" ? panes[which] : void 0;
    if (!url) throw new InvalidPayloadError("unknown permission pane");
    if (process.platform !== "darwin") return false;
    await electron.shell.openExternal(url);
    return true;
  });
  secureHandle("permissions:start-coach", false, async (_e, which) => {
    if (typeof which !== "string") throw new InvalidPayloadError("coach pane must be a string");
    const moves = permissionJourneyWindowMoves();
    return startCoach(which, moves.stepAside, moves.restore);
  });
  secureHandle("permissions:request-microphone", false, async () => {
    if (process.platform !== "darwin") return false;
    const status = electron.systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") return true;
    if (status === "not-determined" || status === "unknown") {
      return electron.systemPreferences.askForMediaAccess("microphone");
    }
    await electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    return true;
  });
  secureHandle("permissions:start-service-coach", false, async (_e, which) => {
    if (which !== "accessibility" && which !== "screenRecording") {
      throw new InvalidPayloadError("service coach pane must be accessibility or screenRecording");
    }
    const binary = bimaxCuServiceBinary();
    if (!binary) return false;
    const marker = ".xpc/Contents/MacOS/";
    const at = binary.indexOf(marker);
    const bundle = at >= 0 ? binary.slice(0, at + ".xpc".length) : binary;
    const moves = permissionJourneyWindowMoves();
    return startCoach(which, moves.stepAside, moves.restore, bundle);
  });
  secureHandle("permissions:stop-coach", false, () => {
    stopCoach("renderer-request");
    return true;
  });
  secureOn("permissions:coach-interactive", (_e, interactive) => {
    setCoachInteractive(interactive === true);
  });
  secureOn("permissions:drag-bundle", (event) => {
    startBundleDrag(event);
  });
  secureHandle("permissions:bundle-path", "", () => coachBundlePath());
  secureHandle("permissions:probe", null, () => probePermissions());
  secureHandle("permissions:relaunch", false, () => {
    stopCoach();
    electron.app.relaunch();
    electron.app.quit();
    return true;
  });
  secureHandle("takeover:get", takeover.state(), () => takeover.state());
  secureHandle("takeover:set", takeover.state(), (_e, raw) => {
    const request = parseTakeoverRequest(raw);
    if (!request) throw new InvalidPayloadError("not a takeover request");
    const next = takeover.set(request);
    broadcast("takeover:state", next);
    return next;
  });
  secureHandle("app:recent-projects", [], () => recentProjects());
  secureHandle("app:open-project", null, (_e, dir) => {
    if (typeof dir === "string" && isRealProject(dir)) {
      startEngine(dir);
      return dir;
    }
    return null;
  });
  secureHandle("app:pick-files", [], async () => {
    if (!win) return [];
    const res = await electron.dialog.showOpenDialog(win, {
      title: "Attach files",
      defaultPath: projectDir() || void 0,
      properties: ["openFile", "multiSelections"]
    });
    if (res.canceled) return [];
    const root = projectDir().replace(/\/+$/, "");
    return res.filePaths.map((p) => p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  });
  secureHandle("git:status", null, () => gitStatus(projectDir()));
  secureHandle("git:diff", "", (_e, file, untracked) => gitDiff(projectDir(), file, untracked === true));
  secureHandle("git:branches", { current: "", all: [] }, () => gitBranches(projectDir()));
  secureHandle("git:log", [], (_e, n) => gitLog(projectDir(), n === void 0 ? 15 : asBoundedInt(n, 1, 1e3, "git log count")));
  secureHandle("files:list", [], (_e, rel) => listDir(projectDir(), rel));
  secureHandle("files:read", null, (_e, rel) => readFilePreview(projectDir(), rel));
  secureHandle("files:reveal", void 0, (_e, rel) => {
    electron.shell.showItemInFolder(resolveWithinRoot(projectDir(), rel, "reveal path"));
  });
  secureHandle("files:write", void 0, (_e, rel, content) => writeFileContent(projectDir(), rel, asFileContent(content)));
  secureHandle("sessions:meta", [], () => readSessionMeta(projectDir()));
  secureHandle("pty:create", -1, (_e, cols, rows) => createPty(projectDir(), asBoundedInt(cols, 2, 1e3, "cols"), asBoundedInt(rows, 2, 1e3, "rows"), {
    onData: (id, data) => broadcast("pty:data", id, data),
    onExit: (id, code) => broadcast("pty:exit", id, code)
  }));
  secureOn("pty:input", (_e, id, data) => writePty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, "pty id"), asPtyInput(data)));
  secureOn("pty:resize", (_e, id, cols, rows) => resizePty(
    asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, "pty id"),
    asBoundedInt(cols, 2, 1e3, "cols"),
    asBoundedInt(rows, 2, 1e3, "rows")
  ));
  secureOn("pty:kill", (_e, id) => killPty(asBoundedInt(id, 1, Number.MAX_SAFE_INTEGER, "pty id")));
  secureHandle("window:chrome", { fullScreen: false, maximized: false, active: true, accent: null }, () => windowChrome());
  secureOn("app:appearance", (_e, appearance) => {
    electron.nativeTheme.themeSource = appearance === "moonlight" ? "dark" : appearance === "starlight" ? "light" : "system";
  });
  secureOn("app:renderer-ready", () => {
    broadcast("takeover:state", takeover.state());
    broadcast("window:chrome", windowChrome());
    const dir = projectDir();
    if (dir) {
      broadcast("app:project", dir);
      if (lastStatus) {
        broadcast("supervisor:status", lastStatus);
        const legacy = legacyState(lastStatus);
        if (legacy) broadcast("engine:state", legacy.state, legacy.detail);
      }
      if (latestUiSnapshot) broadcast("engine:msg", latestUiSnapshot);
      if (latestReviewSnapshot) broadcast("engine:msg", latestReviewSnapshot);
      return;
    }
    if (initialDir) startEngine(initialDir);
    else broadcast("app:project", "");
  });
  electron.app.on("activate", () => {
    revealMainWindow();
  });
});
electron.app.on("window-all-closed", () => {
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", () => {
  supervisor?.dispose();
  supervisor = null;
  killAllPtys();
  projectWatcher?.close();
  projectWatcher = null;
  void focusBroker?.close();
  focusBroker = null;
  void takeoverBroker?.close();
  takeoverBroker = null;
  takeoverBrokerError = null;
  setTakeoverBrokerCredentials(null);
});
