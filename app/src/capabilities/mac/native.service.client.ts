import { execFile } from 'child_process';
import { currentAdHocServiceApproval } from './adhoc.approval.store';

export const BIMAX_CU_PROTOCOL = 'bimax.cu.v1' as const;

/**
 * Semantic actions the native service may advertise. `bimax.cu.v1` grows this catalog additively,
 * so an older service simply omits the newer names and the coordinator must treat them as absent
 * rather than assume they exist.
 */
export const BIMAX_CU_TEXT_ACTIONS = ['select_text_range', 'select_text', 'set_caret'] as const;
// `scroll_page` maps to AXScroll*ByPage, which AppKit, SwiftUI, and Electron advertise and do not
// implement. `scroll_to_fraction` drives the scroll bar's AXValue and is the primitive that works,
// so scroll support is gated on it rather than on the advertised-but-inert page action.
export const BIMAX_CU_SCROLL_ACTIONS = ['scroll_to_fraction', 'scroll_to_visible'] as const;

export interface NativeServiceHandshake {
  selectedProtocol: string;
  serviceVersion: string;
  platform: { os: string; version: string; architecture: string };
  capabilities: {
    observe: { profiles: string[]; scopes: string[]; axDiff: boolean; eventRevisions: boolean; som: boolean; regionCapture: boolean; zoom: boolean; streams: boolean };
    delivery: { policies: string[]; verifiedDeliveryPolicies: string[]; semanticActions: string[]; verifiedSemanticActions: string[]; targetedEvents: boolean; physicalInput: boolean; focusLease: boolean; semanticTransactions: boolean };
    workspace: { apps: boolean; windows: boolean; displays: boolean; spaces: boolean; files: string[]; operations: string[]; verifiedOperations: string[] };
    browser: { typedRoute: boolean; dialogs: boolean; fileInput: boolean; downloads: boolean };
    recording: { trajectory: boolean; video: boolean; replayModes: string[] };
    /** Additive product capability. Absent on older v1 services and therefore unsupported. */
    overlay?: { cursor: boolean };
  };
  limits: {
    maxTransactionSteps: number;
    maxElements: number;
    maxDiffOperations: number;
    maxImageDimension: number;
    maxConcurrentReadSessions: number;
    maxCaptureStreams: number;
  };
  permissions: {
    accessibility: string;
    screenRecording: string;
    screenCapturable: boolean | null;
    inputMonitoring: string;
    serviceSigned: boolean;
    signingIdentifier?: string;
    /** Additive in `bimax.cu.v1`. Optional, so a service that predates them decodes unchanged and a
     *  MISSING field can never be read as a satisfied check. */
    adHocSigned?: boolean;
    signatureIntact?: boolean;
    codeDirectoryHash?: string;
  };
}

export interface NativeServiceProbeResult {
  configured: boolean;
  reachable: boolean;
  routingEligible: boolean;
  /** Why routing is refused. Empty only when the backend is genuinely cutover-ready. */
  cutoverBlockers: string[];
  binary?: string;
  handshake?: NativeServiceHandshake;
  /**
   * The standing ad-hoc approval this probe was assessed against, carried so every later gate can
   * reuse the exact record rather than re-reading the store. Two reads either side of a revoke
   * would otherwise let one surface call the service trusted while another calls it unsigned.
   */
  adHocApproval?: AdHocServiceApproval;
  attempts: number;
  error?: string;
}

/** Actions every backend must advertise before it can be considered for any production traffic. */
export const BIMAX_CU_BASELINE_ACTIONS = ['invoke', 'set_value', 'toggle', 'select'] as const;

/**
 * Delivery policies that change which application the human is looking at. A service may accept
 * them long before it can actually perform them: on macOS a process that is not itself frontmost
 * cannot take the foreground, and every activation API reports success while doing nothing. So
 * these are only ever believed from `verifiedDeliveryPolicies`.
 */
export const BIMAX_CU_FOREGROUND_POLICIES = ['foreground_once', 'foreground_persistent'] as const;

/**
 * Mutating workspace operations, believed only from `verifiedOperations` — the subset the service
 * has actually been watched performing. `launch_app` in particular claims that a process started
 * *and* that the human's foreground did not move, which is exactly the class of claim every
 * activation API in this stack has made falsely.
 */
export function verifiedWorkspaceOperations(handshake: NativeServiceHandshake | undefined): string[] {
  const workspace = handshake?.capabilities.workspace;
  if (!workspace) return [];
  const accepted = new Set(workspace.operations ?? []);
  return (workspace.verifiedOperations ?? []).filter((operation) => accepted.has(operation));
}

/**
 * Support is measured against `verifiedSemanticActions` — the subset the service has actually
 * performed against a live Accessibility server — not against what it will merely accept.
 * `scroll_to_visible` is advertised but unverifiable on AppKit, so scroll support means
 * `scroll_to_fraction`.
 */
function verifiedActions(handshake: NativeServiceHandshake | undefined): string[] {
  return handshake?.capabilities.delivery.verifiedSemanticActions ?? [];
}

/** True only when every text-selection action is verified, never on a partial set. */
export function supportsTextSelection(handshake: NativeServiceHandshake | undefined): boolean {
  const verified = verifiedActions(handshake);
  return BIMAX_CU_TEXT_ACTIONS.every((action) => verified.includes(action));
}

export function supportsPageScrolling(handshake: NativeServiceHandshake | undefined): boolean {
  return verifiedActions(handshake).includes('scroll_to_fraction');
}

function verifiedPolicies(handshake: NativeServiceHandshake | undefined): string[] {
  return handshake?.capabilities.delivery.verifiedDeliveryPolicies ?? [];
}

/**
 * True only when a service has actually been observed taking the foreground and giving it back.
 * The `focusLease` capability flag is not consulted: a flag is a claim, and this is the evidence.
 */
export function supportsFocusLease(handshake: NativeServiceHandshake | undefined): boolean {
  const verified = verifiedPolicies(handshake);
  return BIMAX_CU_FOREGROUND_POLICIES.every((policy) => verified.includes(policy));
}

export interface NativeCutoverAssessment {
  eligible: boolean;
  blockers: string[];
}

/**
 * Same-user development override for the signing requirement, mirroring the existing
 * `BIMAX_CU_ALLOW_UNTRUSTED_CLIENT` escape hatch documented in
 * `docs/BIMAX_CU_SECURITY_MODEL.md` §"Unsigned local development is rejected by default".
 *
 * Why this exists: a local checkout cannot produce `serviceSigned`, because
 * `PermissionDoctor.swift` computes it as `identifier != nil && !adHoc` — an ad-hoc signature is
 * deliberately not enough. That is correct for anything distributed, but it also means the native
 * path is untestable by the person developing it without first buying a Developer ID. The security
 * model already anticipates this case ("an unpackaged development binary reports
 * `service_not_signed`"); this makes the anticipated case reachable instead of merely described.
 *
 * What it does NOT do, on purpose:
 * - it does not touch the XPC client/ancestor checks. Those are separate and still enforced by
 *   `BimaxSignedAncestorAuthorizer`; a bridge still needs `BIMAX_CU_ALLOW_UNTRUSTED_CLIENT=1`.
 * - it does not clear any capability blocker. `physical_input_unavailable`, capture and focus lease
 *   are measurements, and a forged environment variable must never be able to move a measurement.
 * - it is never implied by any other flag, and it defaults off.
 *
 * It is a real reduction in assurance: with it set, an unsigned binary of unknown provenance in the
 * expected path is trusted. That is acceptable for a developer running their own build on their own
 * machine, and unacceptable in anything shipped, which is why callers log it loudly.
 */
export function unsignedServiceOverrideActive(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BIMAX_CU_ALLOW_UNSIGNED_SERVICE === '1';
}

/**
 * A user's standing approval of one exact ad-hoc-signed service binary.
 *
 * Recorded by an explicit, interactive opt-in — never by an environment variable, which any process
 * that can set the environment could forge, and which is why {@link unsignedServiceOverrideActive}
 * stays a DEVELOPMENT-only escape hatch rather than the mechanism here.
 */
export interface AdHocServiceApproval {
  /** The `codeDirectoryHash` the user was shown and accepted. */
  codeDirectoryHash: string;
  approvedAt?: string;
}

/** Why an ad-hoc service is or is not trusted. `trusted` is never true without BOTH checks below. */
export interface AdHocTrustAssessment {
  trusted: boolean;
  reason: string;
}

/**
 * Trust an ad-hoc-signed service on the strength of evidence plus the user's explicit consent.
 *
 * Developer-ID answers two different questions at once — "who made this?" and "has it been altered
 * since?" — and requiring it means a build whose author has no Apple Developer account cannot use
 * the native path at all, however intact it is. This answers the SECOND question only, and asks the
 * user to stand in for the first.
 *
 * **Both conditions are required, and measurement on 2026-08-06 shows why neither is sufficient.**
 * A byte was flipped in the middle of a real ad-hoc binary:
 *
 *   - `signatureIntact` went `true` → `false` (`errSecCSSignatureFailed`, -67061). This is the check
 *     that proves the bytes still match their seal.
 *   - `codeDirectoryHash` did NOT change. It is read out of the signature blob, not recomputed from
 *     the file, so it is a CLAIM the binary makes about itself. Alone it is forgeable.
 *
 * So `signatureIntact` proves the binary is unaltered since sealing, and `codeDirectoryHash` proves
 * it is the same seal the user approved. Checking only the hash would accept a tampered binary that
 * kept its blob; checking only intactness would accept ANY binary an attacker re-signed ad-hoc,
 * which anyone can do for free.
 *
 * What this deliberately does NOT establish is PROVENANCE. Nothing here proves who built the binary
 * — that is exactly the property Developer-ID provides and this cannot — so the approval prompt has
 * to say so plainly rather than implying the code was vouched for by anyone.
 */
export function assessAdHocServiceTrust(
  permissions: NativeServiceHandshake['permissions'],
  approval?: AdHocServiceApproval,
): AdHocTrustAssessment {
  if (permissions.serviceSigned) {
    return permissions.signatureIntact === true
      ? { trusted: true, reason: 'non-ad-hoc signature is intact' }
      : { trusted: false, reason: 'the signed service failed code-signature validation' };
  }
  if (permissions.adHocSigned !== true) {
    return { trusted: false, reason: 'the service is neither production-signed nor ad-hoc signed, so there is no seal to verify' };
  }
  if (permissions.signatureIntact !== true) {
    return { trusted: false, reason: 'the ad-hoc signature does not cover the bytes on disk — this binary was modified after it was sealed' };
  }
  const cdHash = String(permissions.codeDirectoryHash || '').trim().toLowerCase();
  if (!cdHash) {
    return { trusted: false, reason: 'the service reported no code directory hash, so there is nothing an approval could pin' };
  }
  const approved = String(approval?.codeDirectoryHash || '').trim().toLowerCase();
  if (!approved) return { trusted: false, reason: 'this ad-hoc service has not been approved by the user' };
  if (approved !== cdHash) {
    return { trusted: false, reason: `the service binary changed since it was approved (approved ${approved.slice(0, 12)}…, running ${cdHash.slice(0, 12)}…)` };
  }
  return { trusted: true, reason: `ad-hoc signature intact and approved by the user (${cdHash.slice(0, 12)}…)` };
}

/**
 * The signing blocker, with the development override applied. Kept in one place so the shadow gate
 * and the cutover gate cannot drift apart — the failure mode of two copies is one of them quietly
 * not honoring the override, which reads as "the flag does nothing".
 */
function signingBlockers(
  handshake: NativeServiceHandshake,
  env: NodeJS.ProcessEnv = process.env,
  approval?: AdHocServiceApproval,
): string[] {
  if (handshake.permissions.serviceSigned) {
    return handshake.permissions.signatureIntact === true ? [] : ['service_signature_invalid'];
  }
  // A user-approved, intact ad-hoc service is advisory rather than disqualifying — but it stays in
  // every assessment, so no status line or receipt can imply the run carried a production identity.
  if (assessAdHocServiceTrust(handshake.permissions, approval).trusted) {
    return ['service_ad_hoc_user_approved'];
  }
  return unsignedServiceOverrideActive(env) ? ['service_unsigned_development_override'] : ['service_not_signed'];
}

/**
 * Blockers that are advisory rather than disqualifying. `service_unsigned_development_override` is
 * reported so every receipt and status line records that the run was not signed, but it does not
 * make the assessment ineligible.
 */
const ADVISORY_BLOCKERS = new Set([
  'service_unsigned_development_override',
  'service_ad_hoc_user_approved',
]);

function eligibility(blockers: string[]): NativeCutoverAssessment {
  return { eligible: blockers.every(b => ADVISORY_BLOCKERS.has(b)), blockers };
}

/**
 * Phase 9's additive semantic opt-in gate. It intentionally removes only the global physical-input
 * requirement from the full replacement gate: the compatibility ComputerTool remains registered
 * for pointer/key operations, while these native tools expose only verified AX, capture, and
 * workspace operations. Every other signing, observation, catalog, capture, and focus requirement
 * remains identical, so this cannot become an unsigned or observation-only shortcut.
 */
export function assessNativeSemanticOptIn(
  handshake: NativeServiceHandshake | undefined,
  routingEnabled: boolean,
  approval?: AdHocServiceApproval,
): NativeCutoverAssessment {
  const assessment = assessNativeCutover(handshake, routingEnabled, approval);
  const blockers = assessment.blockers.filter(blocker => blocker !== 'physical_input_unavailable');
  return eligibility(blockers);
}

/**
 * Read-only Phase 9 shadow eligibility. Shadowing cannot act or influence the compatibility
 * result, so it does not require capture, focus, semantic actions, or physical input. It still
 * requires the signed service, Accessibility trust, bounded profiles/scopes, diffs, and event
 * revisions: comparison evidence from an unauthenticated or stale observer is worse than no
 * shadow evidence at all.
 */
export function assessNativeShadowEligibility(
  handshake: NativeServiceHandshake | undefined,
  shadowEnabled: boolean,
  approval?: AdHocServiceApproval,
): NativeCutoverAssessment {
  const blockers: string[] = [];
  if (!shadowEnabled) blockers.push('shadow_gate_disabled');
  if (!handshake) {
    blockers.push('service_unreachable');
    return { eligible: false, blockers };
  }
  const observe = handshake.capabilities.observe;
  blockers.push(...signingBlockers(handshake, process.env, approval));
  if (handshake.permissions.accessibility !== 'granted') blockers.push('accessibility_not_granted');
  if (observe.profiles.length === 0) blockers.push('observation_profiles_unavailable');
  if (!observe.scopes.includes('application') || !observe.scopes.includes('window')) {
    blockers.push('shadow_scopes_unavailable');
  }
  if (!observe.axDiff) blockers.push('ax_diff_unavailable');
  if (!observe.eventRevisions) blockers.push('event_revisions_unavailable');
  return eligibility(blockers);
}

/**
 * Structural cutover gate for `docs/BIMAX_CU_SECURITY_MODEL.md`.
 *
 * A rich semantic catalog is not evidence that the native backend can carry production traffic:
 * a service that can select text but cannot capture, type, or take a focus lease would strand any
 * task the moment it left the AX-only path. Every blocker below is derived from the handshake
 * itself, so setting `BIMAX_CU_NATIVE_ROUTING_ENABLED=1` on a service that is not actually ready
 * cannot enable routing. The environment gate is necessary, never sufficient.
 */
export function assessNativeCutover(
  handshake: NativeServiceHandshake | undefined,
  routingEnabled: boolean,
  approval?: AdHocServiceApproval,
): NativeCutoverAssessment {
  const blockers: string[] = [];
  if (!routingEnabled) blockers.push('routing_gate_disabled');
  if (!handshake) {
    blockers.push('service_unreachable');
    return { eligible: false, blockers };
  }
  const { observe, delivery } = handshake.capabilities;
  const advertised = delivery.semanticActions;

  blockers.push(...signingBlockers(handshake, process.env, approval));
  if (handshake.permissions.accessibility !== 'granted') blockers.push('accessibility_not_granted');

  if (observe.profiles.length === 0) blockers.push('observation_profiles_unavailable');
  if (!observe.axDiff) blockers.push('ax_diff_unavailable');
  if (!observe.eventRevisions) blockers.push('event_revisions_unavailable');

  // Baseline delivery must be verified, not merely accepted.
  const verified = delivery.verifiedSemanticActions ?? [];
  if (!BIMAX_CU_BASELINE_ACTIONS.every((action) => verified.includes(action))) {
    blockers.push('semantic_catalog_unverified');
  }
  if (verified.some((action) => !advertised.includes(action))) {
    blockers.push('verified_catalog_inconsistent');
  }
  if (!supportsTextSelection(handshake)) blockers.push('text_selection_unsupported');
  if (!supportsPageScrolling(handshake)) blockers.push('page_scrolling_unsupported');

  // Delivery policies get the same treatment as the action catalog: accepted is not performed.
  const verifiedPolicyList = verifiedPolicies(handshake);
  if (verifiedPolicyList.some((policy) => !delivery.policies.includes(policy))) {
    blockers.push('verified_policies_inconsistent');
  }
  // A service claiming a lease it has not demonstrated is itself a reason to refuse, exactly as a
  // service that claims a verified action it will not accept is.
  if (delivery.focusLease && !supportsFocusLease(handshake)) blockers.push('focus_lease_overclaimed');

  // These three were all refused when this gate was written, and the comment here used to say so:
  // "Both are still refused, so today this function always refuses." That has been WRONG since
  // capture and the focus lease landed, and the stale line cost a live debugging session — it reads
  // as "native is hopeless, stop looking", when the real remaining blockers are much narrower.
  //
  // Measured against the shipped service on 2026-08-02 (`bimax-cu-service --self-test-handshake`,
  // macOS 26.5.2 arm64): regionCapture true, focusLease true with all five delivery policies
  // verified, axDiff true, eventRevisions true, 15 verified semantic actions. The only live
  // blockers are `service_not_signed` and `physical_input_unavailable`.
  //
  // Consequence worth knowing before reading further: signing alone makes
  // `assessNativeSemanticOptIn` eligible, because it drops only the physical-input requirement.
  // Do not restate "always refuses" here without re-running the handshake first.
  if (!observe.regionCapture) blockers.push('capture_unavailable');
  if (!delivery.physicalInput) blockers.push('physical_input_unavailable');
  if (!supportsFocusLease(handshake)) blockers.push('focus_lease_unavailable');

  return eligibility(blockers);
}

export type NativeServiceCommandRunner = (binary: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const defaultRunner: NativeServiceCommandRunner = (binary, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error((stderr || error.message || 'native service probe failed').trim()));
      return;
    }
    resolve(stdout);
  });
});

/**
 * Read-only client for native service discovery.
 *
 * Probes the packaged executable without sending actions. Successful probes are coalesced and
 * cached; failed or malformed probes are retried once and never cached. Native routing remains
 * independently cutover-gated even when the service advertises a tested semantic action subset.
 */
export class NativeServiceCapabilityClient {
  private inFlight: Promise<NativeServiceProbeResult> | null = null;
  private cached: { expiresAt: number; result: NativeServiceProbeResult } | null = null;

  public constructor(
    private readonly binary = process.env.BIMAX_CU_SERVICE_BINARY?.trim() || '',
    private readonly runner: NativeServiceCommandRunner = defaultRunner,
    private readonly timeoutMs = 2_000,
    private readonly cacheTtlMs = 30_000,
    private readonly routingEnabled = process.env.BIMAX_CU_NATIVE_ROUTING_ENABLED === '1',
    // Read per probe rather than captured once: the user can approve or revoke mid-session, and a
    // long-lived client that cached the answer at construction would keep acting on the old one.
    // The gate functions themselves stay pure — an assessment never consults ambient state on its
    // own, so a test that passes no approval always means "no approval".
    private readonly readApproval: () => AdHocServiceApproval | undefined = currentAdHocServiceApproval,
  ) {}

  public probe(force = false): Promise<NativeServiceProbeResult> {
    if (process.platform !== 'darwin') {
      return Promise.resolve({ configured: false, reachable: false, routingEligible: false, cutoverBlockers: ['unsupported_platform'], attempts: 0, error: 'macOS only' });
    }
    if (!this.binary) {
      return Promise.resolve({ configured: false, reachable: false, routingEligible: false, cutoverBlockers: ['service_not_configured'], attempts: 0, error: 'BIMAX_CU_SERVICE_BINARY is not configured' });
    }
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return Promise.resolve(this.cached.result);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runProbe().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  public invalidate(): void { this.cached = null; }

  /** Last successful cached probe for synchronous UI snapshots. Never starts a process or probe. */
  public peek(): NativeServiceProbeResult | null { return this.cached?.result ?? null; }

  private async runProbe(): Promise<NativeServiceProbeResult> {
    let lastError = 'native service probe failed';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const stdout = await this.runner(this.binary, ['--self-test-handshake'], this.timeoutMs);
        const handshake = validateNativeServiceHandshake(JSON.parse(stdout));
        // A capable-looking catalog is not a cutover decision. Eligibility is recomputed from the
        // handshake every probe, so no environment flag can route traffic to a backend that still
        // cannot capture, type, or hold a focus lease.
        const approval = this.readApproval();
        const cutover = assessNativeCutover(handshake, this.routingEnabled, approval);
        const result: NativeServiceProbeResult = {
          configured: true,
          reachable: true,
          routingEligible: cutover.eligible,
          cutoverBlockers: cutover.blockers,
          binary: this.binary,
          handshake,
          ...(approval ? { adHocApproval: approval } : {}),
          attempts: attempt,
        };
        this.cached = { expiresAt: Date.now() + this.cacheTtlMs, result };
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { configured: true, reachable: false, routingEligible: false, cutoverBlockers: ['service_unreachable'], binary: this.binary, attempts: 2, error: lastError };
  }
}

export function validateNativeServiceHandshake(value: unknown): NativeServiceHandshake {
  if (!value || typeof value !== 'object') throw new Error('native service returned a non-object handshake');
  const handshake = value as Partial<NativeServiceHandshake>;
  if (handshake.selectedProtocol !== BIMAX_CU_PROTOCOL) throw new Error(`native service protocol mismatch: ${String(handshake.selectedProtocol)}`);
  if (!handshake.serviceVersion || handshake.platform?.os !== 'macos') throw new Error('native service returned invalid platform metadata');
  if (!handshake.capabilities?.observe || !handshake.capabilities.delivery || !handshake.capabilities.workspace) {
    throw new Error('native service omitted required capability groups');
  }
  const observe = handshake.capabilities.observe as unknown as Record<string, unknown>;
  if (observe.eventRevisions === undefined) observe.eventRevisions = false;
  if (observe.scopes === undefined) observe.scopes = [];
  // A service predating focus conformance omits the field. Absent must read as "nothing proven",
  // never as "everything works".
  // A service predating the workspace-operation slice omits both lists. Absent must read as
  // "no mutating workspace operation exists", never as "every one of them works".
  const workspace = handshake.capabilities.workspace as unknown as Record<string, unknown>;
  if (!Array.isArray(workspace.operations)) workspace.operations = [];
  if (!Array.isArray(workspace.verifiedOperations)) workspace.verifiedOperations = [];
  const delivery = handshake.capabilities.delivery as unknown as Record<string, unknown>;
  if (!Array.isArray(delivery.verifiedDeliveryPolicies)) delivery.verifiedDeliveryPolicies = [];
  if (!Array.isArray(delivery.policies)) delivery.policies = [];
  if (typeof delivery.semanticTransactions !== 'boolean') delivery.semanticTransactions = false;
  if (!Array.isArray(observe.profiles)
      || !Array.isArray(observe.scopes)
      || typeof observe.eventRevisions !== 'boolean'
      || !Array.isArray(handshake.capabilities.delivery.semanticActions)
      || !handshake.limits
      || !handshake.permissions) {
    throw new Error('native service returned malformed capabilities');
  }
  return handshake as NativeServiceHandshake;
}

export const globalNativeServiceCapabilityClient = new NativeServiceCapabilityClient();
