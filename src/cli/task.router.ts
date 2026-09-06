/**
 * Task-TYPE routing, the second axis above `model.router.ts`.
 *
 * The existing router answers "how much model does this turn deserve?" — `lite` or `heavy`, a
 * cost-and-latency decision. That is a real axis and it stays exactly as it was. What it cannot
 * answer is "what KIND of model does this turn need?", and a turn carrying a scanned P&ID does not
 * need a bigger text model, it needs a different one. There was no vision route in the router at
 * all, which meant an image turn was served by whichever text model the weight axis picked.
 *
 * The slot metadata to resolve this was already in the tree and simply unread: every row in
 * `models.ts` declares `recommendedFor: ['coding' | 'vision' | 'lite']`. This module supplies the
 * missing half — deciding which slot a turn belongs to — and keeps the same design constraints the
 * weight router earned: fully local, deterministic, zero model calls, and it can never block or
 * time out a turn.
 *
 * Ordering is the whole design. Slots are tested most-specific first, because the signals overlap:
 * "read this scanned inspection report and draft an approval note" is a vision turn AND a drafting
 * turn, and the model must be able to see the report before anything can be drafted from it. A
 * modality the active model lacks is a hard failure; a deliverable format is not.
 */

import { heuristicTier, localTier, Tier } from './model.router';
import { MODEL_CATALOG, ModelEntry } from './models';

/** What kind of work a turn is. */
export type TaskSlot = 'chat' | 'code' | 'vision' | 'draft';

export interface SlotDecision {
  slot: TaskSlot;
  /** The signal that decided it, in words an operator can check against the prompt. */
  reason: string;
  /** The weight axis, preserved unchanged so existing call sites keep working. */
  tier: Tier;
}

/**
 * Attachment extensions that force the vision slot.
 *
 * PDF and TIFF are here alongside the raster formats because a scanned document reaches the model
 * as rasterized pages — the ingestion path renders them, so the MODEL requirement is a vision model
 * either way. Deciding this from the file extension rather than from the text is what makes the
 * route reliable: a user who drags in a drawing and types "what is this?" gives the classifier no
 * textual signal at all.
 */
const VISION_ATTACHMENT = /\.(png|jpe?g|gif|webp|bmp|tiff?|pdf)$/i;

/** A path or filename mentioned in the prompt itself, for turns with no structured attachment. */
const VISION_PATH_IN_TEXT = /[\w./\\-]+\.(png|jpe?g|gif|webp|bmp|tiff?|pdf)\b/i;

/**
 * Words that name a scanned or drawn source rather than a file.
 *
 * Deliberately narrow. "Diagram" alone is not here: "explain the architecture diagram in the README"
 * is a text turn about a described diagram, and routing it to a vision model with nothing to look at
 * would be strictly worse. These terms name a physical artefact that has to be SEEN.
 */
const VISION_SUBJECT = /\b(scan(?:ned)?|photograph|photo of|screenshot of|handwritten|p&?id\b|piping and instrumentation|engineering drawing|isometric|general arrangement|nameplate|inspection report|blueprint scan)\b/i;

/**
 * The deliverable formats that make a turn a drafting turn.
 *
 * Matching the FORMAT rather than the topic is what keeps this honest: "write the approval note
 * logic in TypeScript" is a coding turn that happens to mention an approval note, and it is caught
 * by the code signals that run first.
 */
const DRAFT_FORMAT = /\.(docx?|pptx?|xlsx?)\b|\b(word document|word file|ms ?word|powerpoint|power ?point|slide deck|presentation deck|spreadsheet|excel (?:file|sheet|workbook)|approval note|office note|board (?:note|presentation)|minutes of meeting)\b/i;

/** Verbs that mean "produce a document", as opposed to "produce code". */
const DRAFT_VERB = /\b(draft|write up|prepare|compose|generate|produce|create|make)\b/i;

export interface SlotContext {
  /**
   * Files structurally attached to the turn. Authoritative when present: a real attachment beats
   * any amount of textual inference, in both directions.
   */
  attachments?: readonly string[];
}

/**
 * Which slot this turn belongs to, and why.
 *
 * The `reason` is not decoration. It is the artefact the demo shows — an evaluator asked to believe
 * that model selection is automatic needs to see what fired, not just which model answered.
 */
export function decideSlot(prompt: string, context: SlotContext = {}): SlotDecision {
  const p = (prompt || '').trim();
  const tier = heuristicTier(p) ?? localTier(p);

  // 1. A structurally attached image or scanned document. Nothing overrides this: the turn cannot
  //    be served at all by a model that cannot see.
  const visual = (context.attachments ?? []).filter(a => VISION_ATTACHMENT.test(a));
  if (visual.length > 0) {
    return {
      slot: 'vision',
      reason: `${visual.length} visual attachment${visual.length === 1 ? '' : 's'} (${visual.map(v => v.split(/[/\\]/).pop()).join(', ')})`,
      tier,
    };
  }

  // 2. A path to one written into the prompt, or a subject that names something that must be seen.
  const pathMatch = VISION_PATH_IN_TEXT.exec(p);
  if (pathMatch) return { slot: 'vision', reason: `the prompt names an image or PDF (${pathMatch[0]})`, tier };
  const subjectMatch = VISION_SUBJECT.exec(p);
  if (subjectMatch) return { slot: 'vision', reason: `the prompt names a scanned or drawn source ("${subjectMatch[0]}")`, tier };

  // 3. Code, before drafting: "write the approval-note writer in TypeScript" is coding work that
  //    merely mentions a document, and the code signals are the more specific of the two.
  if (tier === 'heavy' && heuristicTier(p) === 'heavy' && !DRAFT_FORMAT.test(p)) {
    return { slot: 'code', reason: 'an unmistakable coding signal (verb, code fence, or stack trace)', tier };
  }

  // 4. A document deliverable, when something is actually being produced.
  const formatMatch = DRAFT_FORMAT.exec(p);
  if (formatMatch && DRAFT_VERB.test(p)) {
    return { slot: 'draft', reason: `a document deliverable was requested ("${formatMatch[0]}")`, tier };
  }

  // 5. Fall through to the weight axis. Heavy means work the capable model should do.
  return tier === 'lite'
    ? { slot: 'chat', reason: 'no work signal — conversational or self-contained question', tier }
    : { slot: 'code', reason: 'work signal present, no visual or document deliverable', tier };
}

/**
 * The catalogue slot a task slot resolves to.
 *
 * `draft` maps to `coding` deliberately: producing a well-structured approval note is a reasoning
 * and instruction-following job, not a visual one, and it is the strong model that does it. Adding
 * a fourth catalogue slot for it would mean every model row needing an opinion about drafting that
 * no publisher actually publishes.
 */
export function catalogueSlotFor(slot: TaskSlot): 'coding' | 'vision' | 'lite' {
  switch (slot) {
    case 'vision': return 'vision';
    case 'chat': return 'lite';
    case 'code':
    case 'draft': return 'coding';
  }
}

export interface ModelChoice {
  slot: TaskSlot;
  reason: string;
  tier: Tier;
  /** The model id to serve the turn, or null when the catalogue recommends none for the slot. */
  model: string | null;
  /** Why that model — the catalogue slot it was recommended for, or the fallback that applied. */
  via: 'recommended' | 'configured' | 'none';
  /** Every catalogue model that could serve this slot, best first. */
  candidates: string[];
}

/**
 * Resolve a turn to a concrete model id.
 *
 * `configured` wins over `recommended` because an operator who pinned a model for a slot has made a
 * decision about their own hardware that a shipped catalogue cannot second-guess — on an air-gapped
 * GPU server the catalogue's hosted ids are not even reachable.
 */
export function routeToModel(
  prompt: string,
  context: SlotContext & { configured?: Partial<Record<TaskSlot, string>>; catalogue?: ModelEntry[] } = {},
): ModelChoice {
  const decision = decideSlot(prompt, context);
  const pinned = context.configured?.[decision.slot];
  const wanted = catalogueSlotFor(decision.slot);
  // A model whose PRIMARY tier is the slot outranks a generalist that merely lists the slot among
  // its recommendations. Without this, a catalogue led by a strong all-rounder answers every slot
  // with the same id — the routing is still correct, but a dedicated vision model is genuinely the
  // better vision route, and a route that cannot be distinguished from no routing is not one.
  const catalogue = context.catalogue ?? MODEL_CATALOG;
  const candidates = catalogue
    .filter(entry => entry.recommendedFor?.includes(wanted))
    .sort((a, b) => Number(b.tier === wanted) - Number(a.tier === wanted))
    .map(entry => entry.value);

  if (pinned) return { ...decision, model: pinned, via: 'configured', candidates };
  if (candidates.length > 0) return { ...decision, model: candidates[0], via: 'recommended', candidates };
  return { ...decision, model: null, via: 'none', candidates };
}

/** The human-readable decision record. This is what `/route` prints and what the demo shows. */
export function explainRoute(prompt: string, choice: ModelChoice): string {
  return [
    `Prompt:  ${prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt}`,
    `Slot:    ${choice.slot}   (catalogue slot: ${catalogueSlotFor(choice.slot)})`,
    `Signal:  ${choice.reason}`,
    `Weight:  ${choice.tier}`,
    `Model:   ${choice.model ?? '(no model recommended for this slot)'}   [${choice.via}]`,
    choice.candidates.length > 1
      ? `Others:  ${choice.candidates.slice(1, 5).join(', ')}`
      : '',
    '',
    'Decided locally and deterministically — no classifier round-trip, no network, no model call.',
  ].filter(Boolean).join('\n');
}
