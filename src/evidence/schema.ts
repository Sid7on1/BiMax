// Bimax causal evidence vocabulary — the shared cross-product contract for owner sections 28/29
// (V28B, V29B; see docs/product-reset/11_SECTIONS_28_29_RESEARCH_AND_DELIVERY_PLAN.md §2.2 and
// §10 slice S28-A step 1).
//
// This file is the SOURCE OF TRUTH and is mirrored verbatim into the Desktop app by
// `npm run gen:app-protocol` (drift gate: `npm run check:protocol-mirror`). It must therefore stay
// dependency-free and pure: no `node:` imports, no filesystem, no crypto, no engine types. Hashing,
// persistence and redaction *policy sources* live on each side of the boundary; the vocabulary,
// the canonical serialization and the honesty invariants live here so both products agree on what
// a piece of evidence means and when it is inadmissible.
//
// Two rules from the research shape almost every type below and are enforced, not documented:
//
//   1. "An evidence gap, dropped event or unavailable sensor cannot produce an unqualified safe
//      verdict" (08_ACCEPTANCE_GATES.md, section 28 gate). A Verification therefore carries
//      `satisfied: boolean | null` and `null` is the *required* value when the observation backing
//      it is incomplete or stale. There is no way to spell "safe, but we did not look".
//   2. "A lower level cannot waive a higher-level denial … no model-only block" (§2.3, §6). The
//      detection layer that produced a Decision bounds the disposition it is allowed to carry, in
//      both directions: a model may not block, and a deterministic hard floor may not be softened
//      into an advisory by anything that ran later.

/** Wire identity of this vocabulary. Consumers must reject a payload from another schema line. */
export const EVIDENCE_SCHEMA = 'bimax.evidence/1' as const;
export type EvidenceSchema = typeof EVIDENCE_SCHEMA;

/** JSON-safe value. Evidence crosses a process boundary; nothing else may be stored in it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// --- Identity and relationships ------------------------------------------------------------

/** What an observation is *about*. §2.2 "Identity". */
export type IdentityKind =
  | 'process' | 'executable' | 'package' | 'project' | 'app' | 'endpoint'
  | 'capability' | 'file' | 'user' | 'agent';

export interface Identity {
  kind: IdentityKind;
  /** Stable, already-redacted identifier: a normalized path, bundle id, host:port, package name. */
  id: string;
  display?: string;
  /** Code-signing / publisher identity when macOS or a package manifest supplied one. */
  signer?: string | null;
  /** Content digest when the artifact is content-addressed (`sha256:...`). */
  digest?: string | null;
  /** How Bimax learned this identity exists. Absent means "asserted by the caller", the weakest. */
  provenance?: 'macos' | 'signed-metadata' | 'observed' | 'declared' | null;
}

/** §2.2 "Relationship". The verbs a causal graph edge may use. */
export type RelationshipKind =
  | 'spawned-by' | 'read' | 'wrote' | 'deleted' | 'connected-to' | 'installed-by' | 'loaded-by';

export interface Relationship { kind: RelationshipKind; object: Identity }

// --- Collection contract (§2.1) -------------------------------------------------------------

export type Scope = 'task' | 'project' | 'app' | 'device';
/** Sensitivity class. `secret` is not a storage class — it is a refusal: see `redactFacts`. */
export type Sensitivity = 'public' | 'project' | 'sensitive' | 'secret';
/** Retention class. `none` means the datum may be used for a decision and never persisted. */
export type Retention = 'none' | 'session' | 'task' | 'bounded' | 'audit';

/** Which Bimax component produced an observation. There is no "unknown" sensor. */
export type SensorId =
  | 'engine.tool'
  | 'engine.governor'
  | 'mcp.client'
  | 'package.resolver'
  | 'environment.inventory'
  | 'browser.runtime'
  | 'desktop.mac'
  | 'desktop.broker'
  | 'capability.graph';

/**
 * Whether the evidence behind a claim is whole. Every sensor must report this honestly; a sensor
 * that cannot tell reports `complete: false` with a reason rather than assuming success.
 */
export interface Completeness {
  complete: boolean;
  /** Events the sensor knows it lost (queue overflow, coalesced FSEvents, dropped XPC messages). */
  droppedEvents: number;
  /** Monotonic sequence the sensor was at, when it has one. A gap here is a gap in the graph. */
  sequence?: number | null;
  /** Required whenever `complete` is false. Rendered to the user verbatim. */
  reason?: string | null;
}

export const COMPLETE: Completeness = { complete: true, droppedEvents: 0, sequence: null, reason: null };

export function gap(reason: string, droppedEvents = 0, sequence: number | null = null): Completeness {
  return { complete: false, droppedEvents, sequence, reason };
}

/** True when this completeness record may back a positive ("it is fine") claim. */
export function admissible(c: Completeness): boolean {
  return c.complete && c.droppedEvents === 0;
}

/**
 * Whether a conclusion rests on what was measured or on what something said it would do.
 *
 * This is a different axis from completeness, and conflating the two was a real defect: Terminal has
 * no process-provenance sensor (that is S28-D, entitlement-gated), so the effects of a shell command
 * are read from its text. That is not a *gap* — nothing was dropped, and treating it as one made
 * every ordinary `npm test` raise an evidence-gap finding, which would fail the notification-volume
 * budget in 08_ACCEPTANCE_GATES.md rather than protect anyone.
 *
 * A declared basis is still enough to refuse an operation — a command that names a credential store
 * is refused on its text, exactly as the Governor's static analysis already does. It is not enough
 * to certify an end state, which is why `satisfied: true` requires `observed`.
 */
export type EvidenceBasis = 'observed' | 'declared' | 'mixed';

const BASES: ReadonlySet<string> = new Set<EvidenceBasis>(['observed', 'declared', 'mixed']);

/** True when a value is a real basis. A record that omits it makes no claim about its own footing. */
export function isBasis(value: unknown): value is EvidenceBasis {
  return typeof value === 'string' && BASES.has(value);
}

/** The weaker of two bases. `observed` only survives when nothing declared is mixed in. */
export function combineBasis(a: EvidenceBasis, b: EvidenceBasis): EvidenceBasis {
  if (a === b) return a;
  return 'mixed';
}

/** The basis implied by an identity's provenance. */
export function basisOfProvenance(provenance: Identity['provenance']): EvidenceBasis {
  return provenance === 'declared' || provenance === null || provenance === undefined
    ? 'declared' : 'observed';
}

// --- TaskIntent: what the user approved, and its boundaries ----------------------------------

/**
 * The declared boundary of a task. Absent permission is denial: every field is an allowance, and
 * the default-constructed boundary allows nothing beyond reading the project.
 */
export interface TaskBoundary {
  /** Normalized absolute roots the task may write inside. Empty means "no writes are in scope". */
  writeRoots: string[];
  /** Normalized absolute roots the task may read inside. */
  readRoots: string[];
  /** Hosts the task declared it would contact. Empty with `allowNetwork` means "any declared use". */
  allowedHosts: string[];
  allowNetwork: boolean;
  /** Dependency/lockfile changes — "run tests; do not install" is the canonical §5 contract. */
  allowInstall: boolean;
  allowDeploy: boolean;
  /** Reading credential stores (SSH keys, keychains, browser credential databases). */
  allowCredentialAccess: boolean;
  /** LaunchAgents/LaunchDaemons/login items — persistence, MITRE T1543. */
  allowPersistence: boolean;
  /** Modifying security settings. Never grantable to a Bimax-owned operation; see RULE_IDS. */
  allowSecuritySettings: false;
}

export function emptyBoundary(overrides: Partial<Omit<TaskBoundary, 'allowSecuritySettings'>> = {}): TaskBoundary {
  return {
    writeRoots: [], readRoots: [], allowedHosts: [],
    allowNetwork: false, allowInstall: false, allowDeploy: false,
    allowCredentialAccess: false, allowPersistence: false,
    allowSecuritySettings: false,
    ...overrides,
  };
}

export type ApprovalMode = 'interactive' | 'plan' | 'auto' | 'strict' | 'bypass' | 'unattended';

export interface TaskIntent {
  schema: EvidenceSchema;
  kind: 'TaskIntent';
  id: string;
  createdAt: number;
  /** One line of what the user asked for. Never the full prompt — that is task-scoped content. */
  summary: string;
  projectRoot: string | null;
  boundary: TaskBoundary;
  approvalMode: ApprovalMode;
}

// --- OperationIntent: what the agent or subsystem proposed -----------------------------------

export type Subsystem =
  | 'engine-tool' | 'mcp' | 'package' | 'environment' | 'browser' | 'computer-use' | 'capability';

/**
 * What an operation says it will do, captured *before* it runs. The whole of Layer B is comparing
 * this against the TaskBoundary, and later against what the ActionReceipt shows actually happened.
 */
export interface DeclaredEffects {
  reads: string[];
  writes: string[];
  deletes: string[];
  hosts: string[];
  /** Executables the operation expects to launch, by basename or absolute path. */
  processes: string[];
  installsDependencies: boolean;
  /** Set when the operation is inherently read-only; a write in its receipt then contradicts it. */
  readOnly: boolean;
}

export function noEffects(overrides: Partial<DeclaredEffects> = {}): DeclaredEffects {
  return {
    reads: [], writes: [], deletes: [], hosts: [], processes: [],
    installsDependencies: false, readOnly: false, ...overrides,
  };
}

export interface OperationIntent {
  schema: EvidenceSchema;
  kind: 'OperationIntent';
  id: string;
  taskIntentId: string;
  /** The operation that caused this one. This is the edge the causal path in §5 walks. */
  parentOperationId: string | null;
  createdAt: number;
  subsystem: Subsystem;
  /** Tool/verb name, e.g. `Bash`, `mcp:filesystem/read_file`, `mac.click`, `npm.install`. */
  operation: string;
  actor: Identity;
  declared: DeclaredEffects;
  /**
   * Content that reached this operation from an untrusted source (web page, MCP tool output,
   * package description). Carried so a Decision can say *why* an operation is treated as tainted.
   */
  taint: string[];
}

// --- Observation: an immutable fact from an identified sensor --------------------------------

export interface Observation {
  schema: EvidenceSchema;
  kind: 'Observation';
  id: string;
  createdAt: number;
  sensor: SensorId;
  scope: Scope;
  sensitivity: Sensitivity;
  retention: Retention;
  taskIntentId: string | null;
  operationIntentId: string | null;
  subject: Identity;
  relationship: Relationship | null;
  /** Already-redacted. `redactFacts` is the only supported way to build this. */
  facts: Record<string, JsonValue>;
  /** Age of the underlying measurement when it was recorded, in ms. 0 means "measured now". */
  freshnessMs: number;
  completeness: Completeness;
}

// --- Decision: rule/model versions, factors, disposition -------------------------------------

/**
 * §6 detection stack. The layer is not decoration: `dispositionCeiling` reads it to decide what a
 * layer is permitted to conclude.
 */
export type DetectionLayer =
  | 'A' // invariants — deterministic hard floors
  | 'B' // task and capability mismatch — deterministic, comparison of declared vs approved
  | 'C' // known risky macOS behavior — versioned deterministic rules
  | 'D' // provenance anomaly — explain-only until a labeled local corpus exists
  | 'E' // statistical anomaly — ranks review, never authorizes
  | 'F'; // model-assisted explanation — hypotheses only

/** §7 disposition ladder, ordered from least to most invasive. */
export const DISPOSITIONS = [
  'observe', 'explain', 'recommend', 'require-approval', 'isolate', 'block', 'repair',
] as const;
export type Disposition = typeof DISPOSITIONS[number];

export function dispositionRank(d: Disposition): number { return DISPOSITIONS.indexOf(d); }

function unreachable(value: never): never {
  throw new Error(`unhandled evidence variant: ${String(value)}`);
}

/**
 * The highest disposition a layer may reach on its own. Layers D–F are advisory by construction:
 * "Scores rank review; they do not directly authorize repair or destructive containment" (§6 E) and
 * a model's "output is labeled model explanation … cannot change disposition" (§6 F).
 */
export function dispositionCeiling(layer: DetectionLayer): Disposition {
  switch (layer) {
    case 'A': return 'repair';
    case 'B': return 'block';
    case 'C': return 'require-approval';
    case 'D': return 'recommend';
    case 'E': return 'recommend';
    case 'F': return 'explain';
  }
  return unreachable(layer);
}

/** §7 named factors. A single opaque score is explicitly rejected by the research. */
export interface RiskFactors {
  hardBoundary: boolean;
  taskMismatch: boolean;
  identityTrust: 'macos-verified' | 'signed' | 'known' | 'unknown' | 'contradicted';
  targetSensitivity: Sensitivity;
  persistencePotential: boolean;
  networkNovelty: boolean;
  /** Two or more independently weak signals on one causal path — §5's combined finding. */
  causalCombination: boolean;
  observationCompleteness: Completeness;
  /** 0..1, or null when no statistical layer ran. Never the sole cause of a block or repair. */
  anomalyConfidence: number | null;
}

export interface EvidenceRef {
  /** An Observation id. Findings that cite nothing are vacuous and are rejected by `validate`. */
  observationId: string;
  why: string;
}

export interface Finding {
  /** Stable rule identifier, e.g. `BMX-A-CREDENTIAL-READ`. Registered in RULE_IDS. */
  ruleId: string;
  layer: DetectionLayer;
  /** What happened, in the user's language. */
  what: string;
  /** Which expectation it violated. */
  violated: string;
  /**
   * Who performed it and what it touched. §5 requires every finding to answer "which identity
   * performed it" and "what caused it"; a finding that cannot name a subject is not actionable, so
   * `validate` rejects an empty list.
   */
  subjects: Identity[];
  /** Plausible benign explanations, per §5. Empty is allowed only for Layer A invariants. */
  benignExplanations: string[];
  evidence: EvidenceRef[];
}

export interface Decision {
  schema: EvidenceSchema;
  kind: 'Decision';
  id: string;
  createdAt: number;
  taskIntentId: string;
  operationIntentId: string;
  /** Version of the deterministic rule set that ran. Always present. */
  ruleVersion: string;
  /** Version of the model that contributed an explanation, or null when none did. */
  modelVersion: string | null;
  /** The highest layer that contributed to `disposition`. Bounds it via `dispositionCeiling`. */
  layer: DetectionLayer;
  factors: RiskFactors;
  disposition: Disposition;
  findings: Finding[];
  /** Whether the findings rest on measurement or on declaration. See `EvidenceBasis`. */
  evidenceBasis: EvidenceBasis;
  /** Free-text model hypothesis, always labelled and never load-bearing. */
  modelExplanation: string | null;
}

// --- Approval, ActionReceipt, Verification, Rollback -----------------------------------------

export interface Approval {
  schema: EvidenceSchema;
  kind: 'Approval';
  id: string;
  createdAt: number;
  operationIntentId: string;
  decisionId: string | null;
  grantedBy: 'user' | 'policy';
  /** Exactly what was approved — narrower than or equal to the operation's declared effects. */
  scope: DeclaredEffects;
  /** Absolute ms. `null` means single-use: valid only for the operation it names. */
  expiresAt: number | null;
}

export type ActionOutcome = 'applied' | 'refused' | 'failed' | 'rolled-back';

export interface ActionReceipt {
  schema: EvidenceSchema;
  kind: 'ActionReceipt';
  id: string;
  createdAt: number;
  operationIntentId: string;
  approvalId: string | null;
  /** Which executor actually performed it (`bash`, `native-semantic`, `mcp-stdio`, …). */
  executor: string;
  outcome: ActionOutcome;
  /** What the operation actually touched, as observed — not as declared. */
  observed: DeclaredEffects;
  /** Observation ids for the before state. */
  before: string[];
  /** Observation ids for the after state. */
  after: string[];
  reason: string;
}

export interface Verification {
  schema: EvidenceSchema;
  kind: 'Verification';
  id: string;
  createdAt: number;
  actionReceiptId: string;
  /** Human-readable postcondition that was checked. */
  postcondition: string;
  /**
   * `true` only when the check ran on complete, fresh evidence. `false` is a real negative.
   * `null` is "unknown" and is the required value whenever the evidence cannot support a verdict.
   */
  satisfied: boolean | null;
  /** Age of the evidence the verdict rests on. */
  freshnessMs: number;
  /** Maximum age this postcondition tolerates. Older evidence forces `satisfied: null`. */
  freshnessBudgetMs: number;
  completeness: Completeness;
  /** Measured or declared. A postcondition certified from a declaration certifies nothing. */
  basis: EvidenceBasis;
  evidence: EvidenceRef[];
  reason: string;
}

export interface Rollback {
  schema: EvidenceSchema;
  kind: 'Rollback';
  id: string;
  createdAt: number;
  actionReceiptId: string;
  /** What the restoration targets — a checkpoint id, previous capability version, lockfile digest. */
  target: string;
  result: 'restored' | 'partial' | 'failed' | 'not-required';
  /** Verification id proving the restoration, when one ran. A `restored` claim requires one. */
  verificationId: string | null;
  reason: string;
}

export type EvidenceRecord =
  | TaskIntent | OperationIntent | Observation | Decision
  | Approval | ActionReceipt | Verification | Rollback;

// --- Rule registry ---------------------------------------------------------------------------

/**
 * The deterministic rule identifiers this schema line recognizes. A Finding carrying an
 * unregistered id is rejected: a rule the user cannot look up is not explainable, and §5 requires
 * every finding to name "which rule/model produced the assessment".
 */
export const RULE_IDS = {
  // Layer A — invariants. Not overridable by any approval.
  CREDENTIAL_READ: 'BMX-A-CREDENTIAL-READ',
  PERSISTENCE_WRITE: 'BMX-A-PERSISTENCE-WRITE',
  SECURITY_SETTING_MUTATION: 'BMX-A-SECURITY-SETTING',
  SYSTEM_INTEGRITY: 'BMX-A-SYSTEM-INTEGRITY',
  PLAN_MODE_WRITE: 'BMX-A-PLAN-MODE-WRITE',
  // Layer B — task and capability mismatch.
  WRITE_OUTSIDE_BOUNDARY: 'BMX-B-WRITE-OUTSIDE-BOUNDARY',
  READ_OUTSIDE_BOUNDARY: 'BMX-B-READ-OUTSIDE-BOUNDARY',
  UNDECLARED_INSTALL: 'BMX-B-UNDECLARED-INSTALL',
  UNDECLARED_HOST: 'BMX-B-UNDECLARED-HOST',
  MANIFEST_EXCEEDED: 'BMX-B-MANIFEST-EXCEEDED',
  RECEIPT_CONTRADICTS_INTENT: 'BMX-B-RECEIPT-CONTRADICTS-INTENT',
  // Layer C — known risky macOS behavior.
  LAUNCH_ITEM_CHANGE: 'BMX-C-LAUNCH-ITEM',
  SSH_AUTHORIZED_KEYS: 'BMX-C-SSH-AUTHORIZED-KEYS',
  BROWSER_CREDENTIAL_STORE: 'BMX-C-BROWSER-CREDENTIALS',
  EXECUTABLE_REPLACED: 'BMX-C-EXECUTABLE-REPLACED',
  // Layer D/E/F — advisory.
  PROVENANCE_ANOMALY: 'BMX-D-PROVENANCE-ANOMALY',
  STATISTICAL_ANOMALY: 'BMX-E-STATISTICAL-ANOMALY',
  MODEL_HYPOTHESIS: 'BMX-F-MODEL-HYPOTHESIS',
  // Evidence honesty — reported like any other finding so a gap is visible in the timeline.
  EVIDENCE_GAP: 'BMX-X-EVIDENCE-GAP',
} as const;

export type RuleId = typeof RULE_IDS[keyof typeof RULE_IDS];

const RULE_ID_SET: ReadonlySet<string> = new Set(Object.values(RULE_IDS));

export function isRuleId(value: string): value is RuleId { return RULE_ID_SET.has(value); }

/** The layer a rule id belongs to, read from its own name so the two can never drift apart. */
export function ruleLayer(ruleId: string): DetectionLayer | 'X' | null {
  const match = /^BMX-([ABCDEFX])-/.exec(ruleId);
  return match ? (match[1] as DetectionLayer | 'X') : null;
}

// --- Redaction -------------------------------------------------------------------------------

/**
 * Keys whose values are never stored, at any sensitivity. §4 (S28-2): "Never store environment
 * variables wholesale. Redact tokens, credentials, query parameters, clipboard content, and file
 * contents". Matching is on the normalized key, so `AWS_SECRET_ACCESS_KEY` and `awsSecretAccessKey`
 * are the same key.
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /secret/, /password/, /passwd/, /token/, /apikey/, /credential/, /privatekey/,
  /authorization/, /cookie/, /session(id)?$/, /bearer/, /passphrase/, /keychain/,
  /clipboard/, /filecontents?/, /^content$/, /^body$/, /^env$/, /^environ(ment)?$/,
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(normalized));
}

/** The marker left in place of a redacted value, so the *shape* of the fact survives. */
export const REDACTED = '[redacted]' as const;

/**
 * Strip secret-bearing keys and query strings, recursively. This is the only supported way to build
 * `Observation.facts`; `validate` rejects an Observation whose facts still contain a secret key, so
 * a sensor cannot bypass it by constructing the object literally.
 */
export function redactFacts(input: Record<string, unknown>, depth = 0): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (depth > 6) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isSecretKey(key)) { out[key] = REDACTED; continue; }
    out[key] = redactValue(value, depth);
  }
  return out;
}

function redactValue(value: unknown, depth: number): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return depth > 6 ? [] : value.slice(0, 64).map(v => redactValue(v, depth + 1));
  if (typeof value === 'object') return redactFacts(value as Record<string, unknown>, depth + 1);
  return null;
}

/**
 * Query strings are dropped from anything URL-shaped: §4 names query parameters explicitly, and a
 * host/port/path is enough identity for every decision this schema supports.
 */
export function redactString(value: string): string {
  if (value.length > 4096) return `${value.slice(0, 4096)}…`;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#][^\s]*/i, '$1?[redacted]');
}

/** True when a facts object is already clean — no secret keys survive at any depth. */
export function factsRedacted(facts: Record<string, JsonValue>, depth = 0): boolean {
  if (depth > 8) return true;
  for (const [key, value] of Object.entries(facts)) {
    if (isSecretKey(key) && value !== REDACTED) return false;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!factsRedacted(value as Record<string, JsonValue>, depth + 1)) return false;
    }
  }
  return true;
}

// --- Canonical serialization -----------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped. Content-addressed ids are taken over
 * this string on both sides of the boundary, so Desktop and Terminal derive the same id for the
 * same record and a mutated record cannot keep its id.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: { [k: string]: JsonValue } = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/** The exact bytes an id is computed over: the record without its own `id`. */
export function identityPayload(record: EvidenceRecord): string {
  const { id: _ignored, ...rest } = record as EvidenceRecord & { id: string };
  return canonicalJson(rest);
}

/** Short prefix for a record id, so an id is readable in a log line. */
export function idPrefix(kind: EvidenceRecord['kind']): string {
  switch (kind) {
    case 'TaskIntent': return 'task';
    case 'OperationIntent': return 'op';
    case 'Observation': return 'obs';
    case 'Decision': return 'dec';
    case 'Approval': return 'apr';
    case 'ActionReceipt': return 'rcp';
    case 'Verification': return 'ver';
    case 'Rollback': return 'rbk';
  }
  return unreachable(kind);
}

// --- Validation: the honesty invariants -------------------------------------------------------

export interface ValidationResult { ok: boolean; violations: string[] }

const ok = (): ValidationResult => ({ ok: true, violations: [] });
const fail = (...violations: string[]): ValidationResult => ({ ok: false, violations });

/**
 * Reject a record that would let Bimax make a claim its evidence does not support. This runs on
 * every record before it enters a ledger, on both sides of the boundary. It is deliberately
 * unforgiving: an invalid record is a defect in the producer, not a finding about the user.
 */
export function validate(record: EvidenceRecord): ValidationResult {
  if ((record as { schema?: string }).schema !== EVIDENCE_SCHEMA) {
    return fail(`record is not ${EVIDENCE_SCHEMA}`);
  }
  switch (record.kind) {
    case 'TaskIntent': return validateTaskIntent(record);
    case 'OperationIntent': return validateOperationIntent(record);
    case 'Observation': return validateObservation(record);
    case 'Decision': return validateDecision(record);
    case 'Approval': return validateApproval(record);
    case 'ActionReceipt': return validateActionReceipt(record);
    case 'Verification': return validateVerification(record);
    case 'Rollback': return validateRollback(record);
    default: return fail(`unknown evidence kind ${(record as { kind: string }).kind}`);
  }
}

function validateTaskIntent(record: TaskIntent): ValidationResult {
  const violations: string[] = [];
  if (!record.summary.trim()) violations.push('TaskIntent.summary is empty');
  // `allowSecuritySettings` is typed `false`, but the record may arrive over a wire from an older
  // or hostile producer, so the runtime check has to exist too.
  if ((record.boundary as { allowSecuritySettings: unknown }).allowSecuritySettings === true) {
    violations.push('TaskBoundary.allowSecuritySettings can never be granted');
  }
  if (record.boundary.writeRoots.some(root => !root.startsWith('/'))) {
    violations.push('TaskBoundary.writeRoots must be absolute normalized paths');
  }
  if (record.boundary.readRoots.some(root => !root.startsWith('/'))) {
    violations.push('TaskBoundary.readRoots must be absolute normalized paths');
  }
  return violations.length ? fail(...violations) : ok();
}

function validateOperationIntent(record: OperationIntent): ValidationResult {
  const violations: string[] = [];
  if (!record.taskIntentId) violations.push('OperationIntent must name its TaskIntent');
  if (!record.operation.trim()) violations.push('OperationIntent.operation is empty');
  if (record.parentOperationId === record.id) violations.push('OperationIntent is its own parent');
  const declared = record.declared;
  if (declared.readOnly && (declared.writes.length || declared.deletes.length || declared.installsDependencies)) {
    violations.push('OperationIntent declares readOnly and mutations at once');
  }
  return violations.length ? fail(...violations) : ok();
}

function validateObservation(record: Observation): ValidationResult {
  const violations: string[] = [];
  if (record.sensitivity === 'secret') {
    violations.push('an Observation may not be classified secret — redact it instead of storing it');
  }
  if (!factsRedacted(record.facts)) {
    violations.push('Observation.facts still contains a secret-bearing key');
  }
  if (record.freshnessMs < 0) violations.push('Observation.freshnessMs is negative');
  if (!record.completeness.complete && !record.completeness.reason) {
    violations.push('an incomplete Observation must state why');
  }
  if (!record.subject.id) violations.push('Observation.subject has no identity');
  return violations.length ? fail(...violations) : ok();
}

function validateDecision(record: Decision): ValidationResult {
  const violations: string[] = [];
  const ceiling = dispositionCeiling(record.layer);
  if (dispositionRank(record.disposition) > dispositionRank(ceiling)) {
    violations.push(
      `layer ${record.layer} may not reach disposition ${record.disposition} (ceiling ${ceiling})`,
    );
  }
  if (!record.ruleVersion) violations.push('Decision.ruleVersion is required');
  if (!isBasis(record.evidenceBasis)) {
    violations.push('Decision.evidenceBasis must say whether this rests on measurement or declaration');
  }
  if (record.modelExplanation && !record.modelVersion) {
    violations.push('a model explanation must name the model version that produced it');
  }
  for (const finding of record.findings) {
    if (!isRuleId(finding.ruleId)) {
      violations.push(`finding cites unregistered rule ${finding.ruleId}`);
      continue;
    }
    const layerOfRule = ruleLayer(finding.ruleId);
    if (layerOfRule && layerOfRule !== 'X' && layerOfRule !== finding.layer) {
      violations.push(`finding ${finding.ruleId} claims layer ${finding.layer}`);
    }
    if (!finding.evidence.length) {
      violations.push(`finding ${finding.ruleId} cites no observation — a vacuous finding`);
    }
    if (!finding.subjects.length) {
      violations.push(`finding ${finding.ruleId} names no identity that performed or received it`);
    }
    if (finding.layer !== 'A' && !finding.benignExplanations.length) {
      violations.push(`finding ${finding.ruleId} offers no plausible benign explanation`);
    }
  }
  // §6 F and §7: a block or a repair must rest on something deterministic. An anomaly score, however
  // confident, is not that thing.
  if (dispositionRank(record.disposition) >= dispositionRank('block')) {
    const deterministic = record.findings.some(f => f.layer === 'A' || f.layer === 'B' || f.layer === 'C');
    if (!deterministic) violations.push('block/repair requires a deterministic Layer A/B/C finding');
    if (!record.findings.length) violations.push('block/repair with no findings');
  }
  // An unfinished picture may raise suspicion, never lower it: a gap can escalate to explain, but
  // it cannot be the reason a Decision settles at `observe`.
  if (!admissible(record.factors.observationCompleteness) && record.disposition === 'observe') {
    violations.push('a Decision on incomplete evidence may not settle at observe');
  }
  // Refusing on a declaration is legitimate — a command that names a credential store is refused on
  // its text. Repairing on one is not: a correction mutates the machine, and §8 requires it to start
  // from "fresh minimal evidence", not from what a tool said it was about to do.
  if (record.disposition === 'repair' && record.evidenceBasis !== 'observed') {
    violations.push(`a repair requires observed evidence; this rests on ${record.evidenceBasis} effects`);
  }
  if (record.factors.anomalyConfidence !== null
    && (record.factors.anomalyConfidence < 0 || record.factors.anomalyConfidence > 1)) {
    violations.push('anomalyConfidence must be within 0..1');
  }
  return violations.length ? fail(...violations) : ok();
}

function validateApproval(record: Approval): ValidationResult {
  const violations: string[] = [];
  if (!record.operationIntentId) violations.push('Approval must name the operation it approves');
  if (record.expiresAt !== null && record.expiresAt <= record.createdAt) {
    violations.push('Approval expires at or before it was granted');
  }
  return violations.length ? fail(...violations) : ok();
}

function validateActionReceipt(record: ActionReceipt): ValidationResult {
  const violations: string[] = [];
  if (!record.operationIntentId) violations.push('ActionReceipt must name its OperationIntent');
  if (!record.executor) violations.push('ActionReceipt must name the executor that ran it');
  if (record.outcome === 'applied' && !record.after.length) {
    violations.push('an applied ActionReceipt must cite after-state observations');
  }
  if (record.outcome === 'rolled-back' && !record.before.length) {
    violations.push('a rolled-back ActionReceipt must cite the before state it returned to');
  }
  return violations.length ? fail(...violations) : ok();
}

function validateVerification(record: Verification): ValidationResult {
  const violations: string[] = [];
  if (!record.actionReceiptId) violations.push('Verification must name its ActionReceipt');
  if (record.freshnessBudgetMs <= 0) violations.push('Verification.freshnessBudgetMs must be positive');
  const stale = record.freshnessMs > record.freshnessBudgetMs;
  const incomplete = !admissible(record.completeness);
  // The rule the whole schema exists for. Stale or incomplete evidence yields "unknown", and the
  // type system cannot express that — only this check can.
  if (record.satisfied === true && (stale || incomplete)) {
    violations.push(
      'a satisfied Verification requires complete, fresh evidence: '
      + [stale ? `evidence is ${record.freshnessMs}ms old against a ${record.freshnessBudgetMs}ms budget` : '',
        incomplete ? (record.completeness.reason || 'observation is incomplete') : '']
        .filter(Boolean).join('; '),
    );
  }
  // The other half of the same rule. Complete, fresh evidence *of a declaration* still says nothing
  // about the end state, and a postcondition is a claim about the end state.
  if (record.satisfied === true && record.basis !== 'observed') {
    violations.push(
      `a satisfied Verification requires observed evidence; this rests on ${record.basis} effects`,
    );
  }
  if (!isBasis(record.basis)) {
    violations.push('Verification.basis must say whether the postcondition was measured or declared');
  }
  if (record.satisfied !== null && !record.evidence.length) {
    violations.push('a Verification verdict must cite the observations it rests on');
  }
  if (!record.reason.trim()) violations.push('Verification.reason is empty');
  return violations.length ? fail(...violations) : ok();
}

/**
 * Turn a raw postcondition observation into an admissible verdict.
 *
 * Producers must not assign `Verification.satisfied` themselves — this is the only function that
 * decides it. A negative stays negative no matter how patchy the evidence is (Bimax saw something
 * wrong, and hiding that behind "unknown" would be the same lie in the other direction). Only the
 * positive requires complete, fresh evidence; otherwise the verdict is `null`, "we cannot say".
 */
export function concludeSatisfied(
  observedTruth: boolean,
  freshnessMs: number,
  freshnessBudgetMs: number,
  completeness: Completeness,
): boolean | null {
  if (!observedTruth) return false;
  if (!admissible(completeness)) return null;
  if (freshnessMs > freshnessBudgetMs) return null;
  return true;
}

function validateRollback(record: Rollback): ValidationResult {
  const violations: string[] = [];
  if (!record.actionReceiptId) violations.push('Rollback must name its ActionReceipt');
  if (!record.target) violations.push('Rollback must name a restoration target');
  // "mutation testing proves a fake repair cannot pass when end state is wrong" (S28-C exit). A
  // restoration that was never independently checked is a claim, not a result.
  if (record.result === 'restored' && !record.verificationId) {
    violations.push('a restored Rollback must cite an independent Verification');
  }
  return violations.length ? fail(...violations) : ok();
}
