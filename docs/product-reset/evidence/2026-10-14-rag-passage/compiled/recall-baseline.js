"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECALL_PREFIX = void 0;
exports.recallQuery = recallQuery;
exports.recallKey = recallKey;
exports.recallForTurn = recallForTurn;
exports.answeringExcerpt = answeringExcerpt;
exports.droppedRecall = droppedRecall;
const capability_status_1 = require("../core/capability.status");
const evidence_1 = require("../context/evidence");
const bm25_1 = require("./bm25");
const sufficiency_1 = require("./sufficiency");
exports.RECALL_PREFIX = '[Recalled memory]';
/** Below this a message is an acknowledgement, not a question. Measured in characters. */
const MIN_QUERY_CHARS = 24;
/**
 * Whether this turn should trigger a recall, and on what.
 *
 * Pure and exported so the policy is testable without a store, a model or a loop — every one of the
 * guards above is a decision that can regress silently otherwise.
 */
function recallQuery(role, content, alreadyAsked) {
    if (role !== 'user')
        return null;
    if (typeof content !== 'string')
        return null;
    const text = content.trim();
    if (text.length < MIN_QUERY_CHARS)
        return null;
    // Slash commands are instructions to the CLI, not questions about the work.
    if (text.startsWith('/'))
        return null;
    // Our own injected blocks must never become a query — that recalls against a recall.
    if (text.startsWith(exports.RECALL_PREFIX))
        return null;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (alreadyAsked.has(key))
        return null;
    return text;
}
/** Normalized form used to remember what has already been recalled against this session. */
function recallKey(query) {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
/**
 * Run the pipeline for this turn and format what it found.
 *
 * Returns null when there is nothing worth injecting, which includes the case where retrieval
 * itself failed — a recall block that says "no memories found" is noise the model has to read.
 */
/** What automatic recall never searches: the persona injects project memory itself, and code belongs to code search. */
const RECALL_EXCLUDED_TAGS = ['project-memory', 'code'];
async function recallForTurn(store, query, options = {}) {
    options.signal?.throwIfAborted();
    const limit = options.limit ?? 3;
    const maxChars = options.maxChars ?? 1_800;
    let documents;
    try {
        // A floor of 0: the whole point is finding things phrased differently, and a lexical-overlap
        // threshold would filter out exactly those.
        //
        // project-memory is EXCLUDED: the persona already injects those as a prompt block every turn
        // (conventions are deliberately re-shown), and one memory arriving twice — from two paths
        // that cannot see each other — is the exact token cost this module's guards exist to prevent.
        // code is EXCLUDED for the same reason from the other side: source chunks belong to
        // CodeSearchTool, and auto-recall injecting a wall of code into a user turn is displacement,
        // not help. Recall is for durable knowledge; code has its own door.
        documents = await store.semanticSearch(query, limit, 0, { excludeTags: RECALL_EXCLUDED_TAGS, passages: true });
    }
    catch {
        options.signal?.throwIfAborted();
        (0, capability_status_1.reportCapability)({ id: 'memory-recall', label: 'Memory recall', state: 'degraded',
            reason: 'Memory lookup failed.', impact: 'This turn continues without recalled context.',
            action: 'Check memory storage and retrieval settings.' });
        return null;
    }
    options.signal?.throwIfAborted();
    (0, capability_status_1.reportCapability)({ id: 'memory-recall', label: 'Memory recall', state: 'ready',
        reason: 'Memory lookup completed.', impact: '', action: '' });
    if (!documents.length)
        return null;
    // Lexical retrieval cannot tell a note that answers from one that shares a word with the question. When at least half
    // of the question's content words appear in no memory at all, memory does not know the subject: inject nothing
    // (record 47 §4, benchmark S5). With the dense stage on, a paraphrase can match without shared words, so this stays off.
    // A store that cannot say how it searched or what it holds (a partial stand-in) gets no abstention, as before.
    const lexicalOnly = typeof store.lastSearchMode === 'function' && !store.lastSearchMode().dense;
    if (lexicalOnly && typeof store.unknownTerms === 'function') {
        const asked = (0, sufficiency_1.contentStems)(query);
        if (asked.length && store.unknownTerms(asked, { excludeTags: RECALL_EXCLUDED_TAGS }).length / asked.length >= sufficiency_1.UNKNOWN_SUBJECT_SHARE) {
            return null;
        }
    }
    const parts = [];
    const ids = [];
    const evidence = [];
    let budget = maxChars;
    for (const [index, doc] of documents.entries()) {
        // Reserve a useful excerpt for later retrieved sources rather than spending the whole
        // prompt allowance on the first long note. Small budgets still prioritize the best source.
        const reservePerSource = MIN_EXCERPT_CHARS + LABEL_ALLOWANCE + 3;
        const later = Math.min(documents.length - index - 1, Math.max(0, Math.floor((budget - reservePerSource) / reservePerSource)));
        const passage = passageOf(doc, budget - later * reservePerSource, query);
        const content = passage.text;
        if (!content)
            continue;
        // Truncate the last one that fits rather than dropping it: a partial memory is usually still
        // the fact that was wanted, and the alternative is silently recalling less than the budget.
        const shown = content.length <= budget ? content : content.slice(0, Math.max(0, budget - 1)).trimEnd();
        const slice = shown === content ? content : `${shown}…`;
        if (!shown)
            break;
        parts.push(`- ${slice}`);
        ids.push(doc.id);
        evidence.push(...memoryEvidence(doc, passage, shown.length));
        budget -= slice.length + 3;
        if (budget <= 80)
            break;
    }
    if (!parts.length)
        return null;
    return {
        ids,
        evidence,
        text: [
            `${exports.RECALL_PREFIX} — retrieved for this turn, not stated by the user. May be outdated; verify before relying on it.`,
            ...parts,
        ].join('\n'),
    };
}
/** Room left for a label such as "(part 12 of 12, excerpt) " and the joiner, per segment. */
const LABEL_ALLOWANCE = 28;
/** A later chunk is excerpted only when at least this much of the budget is left for it. */
const MIN_EXCERPT_CHARS = 120;
/**
 * The lines of `text` that best answer `query`, contiguous and within `budget` characters: the line holding the most
 * weight of query terms, widened by its neighbours while they fit. A term weighs more the fewer lines hold it, so a
 * word on every line does not choose the line. With no query term in `text`, its head, as before.
 *
 * This is the "exact span" representation of record 47 §3.4 for recall. Showing the head of a chunk the budget could
 * not hold cut the answer whenever it sat at the chunk's end (context benchmark case B5).
 */
function answeringExcerpt(text, query, budget) {
    if (budget <= 0)
        return '';
    if (text.length <= budget)
        return text;
    const lines = text.split('\n');
    const terms = [...new Set((0, bm25_1.tokenize)(query))];
    const lineTerms = lines.map((line) => new Set((0, bm25_1.tokenize)(line)));
    const weight = new Map(terms.map((term) => {
        const holding = lineTerms.filter((set) => set.has(term)).length;
        return [term, holding ? Math.log(1 + lines.length / holding) : 0];
    }));
    let best = -1;
    let bestScore = 0;
    lineTerms.forEach((set, i) => {
        let score = 0;
        for (const term of terms)
            if (set.has(term))
                score += weight.get(term);
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    });
    if (best < 0)
        return text.slice(0, budget).trimEnd();
    if (lines[best].length > budget)
        return lines[best].slice(0, budget).trimEnd();
    let start = best;
    let end = best + 1;
    let length = lines[best].length;
    for (let grew = true; grew;) {
        grew = false;
        if (end < lines.length && length + 1 + lines[end].length <= budget) {
            length += 1 + lines[end].length;
            end++;
            grew = true;
        }
        if (start > 0 && length + 1 + lines[start - 1].length <= budget) {
            start--;
            length += 1 + lines[start].length;
            grew = true;
        }
    }
    return lines.slice(start, end).join('\n').trim();
}
const PASSAGE_JOINER = '\n  ';
function passageOf(doc, budget, query) {
    const chunks = doc.chunks ?? [];
    const matched = doc.matchedChunks ?? [];
    if (!matched.length || !chunks.length) {
        const whole = (doc.metadata?.content || '').trim();
        const body = whole.length > budget ? answeringExcerpt(whole, query, Math.max(0, budget - LABEL_ALLOWANCE)) : whole;
        const partial = body.length < whole.length;
        return { text: `${partial ? '(excerpt) ' : ''}${body}`, segments: body ? [{ chunk: null, label: partial ? '(excerpt) ' : '', body, partial }] : [] };
    }
    const picked = [];
    let used = 0;
    for (const chunk of matched) {
        const whole = chunk.text.trim();
        if (used + whole.length + LABEL_ALLOWANCE <= budget) {
            picked.push({ chunk, body: whole });
            used += whole.length + LABEL_ALLOWANCE;
            continue;
        }
        // A chunk the budget cannot hold is shown as the lines that answer the query. The best chunk always gets its
        // excerpt; a later one only when enough budget is left to say something.
        const room = budget - used - LABEL_ALLOWANCE;
        if (picked.length && room < MIN_EXCERPT_CHARS)
            continue;
        const body = answeringExcerpt(whole, query, Math.max(0, room));
        if (!body)
            continue;
        picked.push({ chunk, body });
        used += body.length + LABEL_ALLOWANCE;
    }
    const segments = picked
        .map(({ chunk, body }) => ({ chunk, body, at: chunks.indexOf(chunk), partial: body.length < chunk.text.trim().length }))
        .sort((a, b) => a.at - b.at)
        .map(({ chunk, body, at, partial }) => {
        const position = chunks.length > 1 && at >= 0 ? `part ${at + 1} of ${chunks.length}` : '';
        const label = position || partial ? `(${[position, partial ? 'excerpt' : ''].filter(Boolean).join(', ')}) ` : '';
        return { chunk, body, label, partial };
    })
        .filter((segment) => segment.body);
    return { text: segments.map((segment) => segment.label + segment.body).join(PASSAGE_JOINER), segments };
}
/**
 * A recalled document as evidence: one span per injected chunk, or one for the whole note when no chunk was reported,
 * holding exactly the text the recall block shows. The first `shownChars` of the passage reached the prompt; a chunk
 * the budget cut is recorded as its visible part and marked partial, and one cut entirely is not recorded. Recording
 * the whole chunk claimed the model saw text it never did (audit 51, U07). The version is the hash of the stored text.
 * A memory records no date, so `validFrom` stays unset rather than guessed.
 */
function memoryEvidence(doc, passage, shownChars) {
    const content = doc.metadata?.content || '';
    const chunks = doc.chunks ?? [];
    const base = {
        sourceId: `memory:${doc.id}`,
        sourceVersion: (0, evidence_1.versionOfText)(content),
        scope: { tags: doc.metadata?.tags ?? [] },
        derivedFrom: [],
        kind: 'source',
    };
    const spans = [];
    let offset = 0;
    passage.segments.forEach((segment, n) => {
        if (n > 0)
            offset += PASSAGE_JOINER.length;
        const start = offset + segment.label.length;
        offset = start + segment.body.length;
        const text = segment.body.slice(0, Math.max(0, Math.min(segment.body.length, shownChars - start))).trimEnd();
        if (!text)
            return;
        const partial = text.length < segment.body.length || segment.partial ? { partial: true } : {};
        const locator = segment.chunk
            ? { kind: 'memory', documentId: doc.id, part: chunks.indexOf(segment.chunk) + 1, parts: chunks.length, ...partial }
            : { kind: 'memory', documentId: doc.id, ...partial };
        spans.push((0, evidence_1.evidenceSpan)({ ...base, locator, text }));
    });
    return spans;
}
/**
 * Whether compaction dropped a recall block: `before` held one that `after` no longer contains.
 *
 * Compaction drops recall blocks because they are evidence for the turn they were retrieved for. The
 * session's "already recalled" set has to forget when that happens, or a question whose evidence was
 * compacted away could never recall again (record 47, A04).
 */
function droppedRecall(before, after) {
    const kept = new Set(after);
    return before.some((message) => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith(exports.RECALL_PREFIX)
        && !kept.has(message));
}
