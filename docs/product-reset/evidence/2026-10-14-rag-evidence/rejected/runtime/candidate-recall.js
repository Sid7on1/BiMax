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
    const maxChars = options.maxChars ?? 6_000;
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
        // Share evidence room across sources. Short notes return their unused share to the next
        // source; a tiny budget still belongs to the best result rather than unusable fragments.
        const reservePerSource = MIN_EXCERPT_CHARS + LABEL_ALLOWANCE + 3;
        const later = Math.min(documents.length - index - 1, Math.max(0, Math.floor((budget - reservePerSource) / reservePerSource)));
        const share = later ? Math.floor(budget / (later + 1)) : budget;
        const passage = passageOf(doc, share, query);
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
        return wordWindow(lines[best], query, budget);
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
/** A linear sliding word window, with rare query terms and balanced surrounding context. */
function wordWindow(text, query, budget) {
    const terms = new Set((0, bm25_1.tokenize)(query));
    const words = [...text.matchAll(/\S+/gu)].map(match => ({
        start: match.index, end: match.index + match[0].length,
        terms: [...new Set((0, bm25_1.tokenize)(match[0]).filter(term => terms.has(term)))],
    }));
    const frequency = new Map();
    for (const word of words)
        for (const term of word.terms)
            frequency.set(term, (frequency.get(term) ?? 0) + 1);
    if (!frequency.size)
        return text.slice(0, budget).trimEnd();
    const weights = new Map([...frequency].map(([term, count]) => [term, Math.log(1 + words.length / count)]));
    const counts = new Map();
    let score = 0, mass = 0, position = 0, right = 0;
    let bestScore = 0, bestDistance = Infinity, bestStart = 0, bestEnd = Math.min(text.length, budget);
    const change = (word, delta) => {
        for (const term of word.terms) {
            const before = counts.get(term) ?? 0, weight = weights.get(term);
            counts.set(term, before + delta);
            if (!before && delta === 1)
                score += weight;
            if (before === 1 && delta === -1)
                score -= weight;
            mass += delta * weight;
            position += delta * weight * (word.start + word.end) / 2;
        }
    };
    for (let left = 0; left < words.length; left++) {
        if (right < left)
            right = left;
        while (right < words.length && words[right].end - words[left].start <= budget)
            change(words[right++], 1);
        if (right > left && mass > 0) {
            const start = words[left].start, end = words[right - 1].end;
            const distance = Math.abs(position / mass - (start + end) / 2);
            if (score > bestScore + 1e-10 || (Math.abs(score - bestScore) <= 1e-10 && distance < bestDistance)) {
                bestScore = score;
                bestDistance = distance;
                bestStart = start;
                bestEnd = end;
            }
        }
        if (right > left)
            change(words[left], -1);
    }
    return text.slice(bestStart, bestEnd).trim();
}
const PASSAGE_JOINER = '\n  ';
function passageOf(doc, budget, query) {
    const chunks = doc.chunks ?? [];
    const matched = doc.matchedChunks ?? [];
    const source = (doc.metadata?.content || '').trim();
    // This is quoted source text, never a date inferred from last retrieval or a benchmark label.
    const firstLine = source.split('\n', 1)[0].trim();
    const header = firstLine.length <= 160 && /^(?:session\s+date|date|timestamp)\s*:/i.test(firstLine)
        && budget >= firstLine.length + MIN_EXCERPT_CHARS + LABEL_ALLOWANCE ? firstLine : '';
    const bodyBudget = budget - (header ? header.length + PASSAGE_JOINER.length : 0);
    const finish = (segments) => {
        if (header && !segments.some(segment => segment.body.includes(header))) {
            segments.unshift({ chunk: null, label: '', body: header });
        }
        return { text: segments.map(segment => segment.label + segment.body).join(PASSAGE_JOINER), segments };
    };
    if (!matched.length || !chunks.length) {
        const whole = source;
        const body = whole.length > bodyBudget ? answeringExcerpt(whole, query, Math.max(0, bodyBudget - LABEL_ALLOWANCE)) : whole;
        const partial = body.length < whole.length;
        return finish(body ? [{ chunk: null, label: partial ? '(excerpt) ' : '', body, partial }] : []);
    }
    const picked = [];
    const unique = [];
    const seen = new Set();
    for (const chunk of matched) {
        const text = chunk.text.trim();
        if (!text || seen.has(text))
            continue;
        seen.add(text);
        unique.push(chunk);
        if (unique.length === 4)
            break;
    }
    if (!unique.length)
        return { text: '', segments: [] };
    // Bound the number of fragments; preserve retrieval order for admission, source order for reading.
    const count = Math.min(4, unique.length, Math.max(1, Math.floor(bodyBudget / (MIN_EXCERPT_CHARS + LABEL_ALLOWANCE))));
    let used = 0;
    for (const chunk of unique.slice(0, count)) {
        const whole = chunk.text.trim();
        const remaining = count - picked.length;
        const share = Math.floor((bodyBudget - used) / remaining);
        if (whole.length + LABEL_ALLOWANCE <= share) {
            picked.push({ chunk, body: whole });
            used += whole.length + LABEL_ALLOWANCE;
            continue;
        }
        // A chunk the budget cannot hold is shown as the lines that answer the query. The best chunk always gets its
        // excerpt; a later one only when enough budget is left to say something.
        const room = share - LABEL_ALLOWANCE;
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
    return finish(segments);
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
