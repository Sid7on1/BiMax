import * as path from 'path';
import { findSecrets, parseEnv } from './secrets';

/**
 * God's Land stage 7 (docs/product-reset/gods-land/03_PLAN.md, 00 §4 "In-Flight Transmutations", §"Smart One-Tap Quick
 * Actions"): what a card on the shelf can become, in one tap.
 *
 * Two kinds, never mixed up:
 * - LOCAL: done by the notch's helper with the Mac's own frameworks (ImageIO, PDFKit, Vision) — no model, nothing sent.
 *   The result is a new card beside the original. WebP is not offered: ImageIO reads it but cannot write it on this Mac
 *   (measured 2026-09-26); AVIF and HEIC are the modern formats it can write.
 * - TASK: needs a model, so it becomes a ⌘2 task — the Droplet, the file attached, the request already written.
 *
 * The order is learned: each file type's actions are sorted by how often the person used them (01 §3), the rest keep
 * their default order.
 */

export interface Transmutation {
  id: string;
  label: string;
  /** local: the helper does it; task: a ⌘2 task with `prompt`. */
  kind: 'local' | 'task';
  prompt?: string;
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.avif']);
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.swift', '.java', '.kt', '.rb', '.php', '.c', '.cpp', '.h', '.cs']);
const DATA = new Set(['.csv', '.tsv', '.json', '.xlsx', '.sql']);
const NOTES = new Set(['.md', '.txt', '.rtf', '.docx']);

export type FileFamily = 'image' | 'pdf' | 'code' | 'data' | 'notes' | 'env' | 'other';

export function familyOf(file: string): FileFamily {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  if (base === '.env' || base.startsWith('.env.') || ext === '.env') return 'env';
  if (IMAGE.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (CODE.has(ext)) return 'code';
  if (DATA.has(ext)) return 'data';
  if (NOTES.has(ext)) return 'notes';
  return 'other';
}

/** Each family's actions in their default order. The owner's brainstorm lists, less what the Mac cannot do. */
const DEFAULTS: Record<FileFamily, Transmutation[]> = {
  image: [
    { id: 'compress', label: 'Compress', kind: 'local' },
    { id: 'avif', label: 'To AVIF', kind: 'local' },
    { id: 'heic', label: 'To HEIC', kind: 'local' },
    { id: 'png', label: 'To PNG', kind: 'local' },
    { id: 'jpeg', label: 'To JPEG', kind: 'local' },
    { id: 'remove-background', label: 'Remove Background', kind: 'local' },
    { id: 'ocr', label: 'Copy Text', kind: 'local' },
    { id: 'base64', label: 'Copy as Base64', kind: 'local' },
  ],
  pdf: [
    { id: 'pdf-compress', label: 'Compress for Email', kind: 'local' },
    { id: 'pdf-page1', label: 'Extract Page 1', kind: 'local' },
    { id: 'pdf-flatten', label: 'Flatten', kind: 'local' },
    { id: 'task:summarise', label: 'Summarise', kind: 'task', prompt: 'Summarise this document in five key points.' },
    { id: 'task:tables', label: 'Tables to CSV', kind: 'task', prompt: 'Extract every table in this document into CSV files next to it.' },
  ],
  code: [
    { id: 'task:tests', label: 'Add Tests', kind: 'task', prompt: 'Add unit tests for this file, covering its edge cases, and run them.' },
    { id: 'task:document', label: 'Document', kind: 'task', prompt: 'Add clear documentation comments to this file without changing its behaviour.' },
    { id: 'task:optimize', label: 'Optimise', kind: 'task', prompt: 'Find and fix performance problems in this file, and show what changed.' },
  ],
  data: [
    { id: 'task:summarise', label: 'Summarise', kind: 'task', prompt: 'Summarise what this data contains, with its key numbers.' },
    { id: 'task:types', label: 'Types', kind: 'task', prompt: 'Write TypeScript types (with Zod schemas) that describe this data.' },
    { id: 'task:mock', label: 'Mock Data', kind: 'task', prompt: 'Generate 50 rows of realistic mock data with the same shape as this file.' },
  ],
  notes: [
    { id: 'task:concise', label: 'Make Concise', kind: 'task', prompt: 'Rewrite this to be concise, keeping every fact.' },
    { id: 'task:grammar', label: 'Fix Grammar', kind: 'task', prompt: 'Fix the grammar and spelling in this file without changing its meaning.' },
    { id: 'task:summarise', label: 'Summarise', kind: 'task', prompt: 'Summarise this in five key points.' },
  ],
  env: [
    { id: 'env-example', label: 'Make .env.example', kind: 'local' },
    { id: 'task:validate', label: 'Validate', kind: 'task', prompt: 'Check this config file for missing, malformed or unused settings — without printing any secret values.' },
  ],
  other: [],
};

/** A file's actions, most used first for its family (by `counts`: `family:id` → uses), ties in default order. */
export function transmutationsFor(file: string, counts: Readonly<Record<string, number>> = {}): Transmutation[] {
  const family = familyOf(file);
  const list = DEFAULTS[family];
  return list.map((t, i) => ({ t, i, uses: counts[`${family}:${t.id}`] ?? 0 })).sort((a, b) => b.uses - a.uses || a.i - b.i).map(({ t }) => t);
}

/** Counting one use, for the learned order. */
export function countUse(counts: Readonly<Record<string, number>>, file: string, id: string): Record<string, number> {
  const key = `${familyOf(file)}:${id}`;
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/** Whether `id` is an action this file really has (the helper's request is checked, never trusted). */
export function isTransmutation(file: string, id: string): Transmutation | null {
  return DEFAULTS[familyOf(file)].find((t) => t.id === id) ?? null;
}

// ── .env → .env.example (local, done here: it reads secrets, which stay in this process) ──────────────────────────

/** The same file with every value that could be a secret replaced by a placeholder; comments and layout kept. */
export function envExample(text: string): string {
  const entries = new Map(parseEnv(text).map((e) => [e.line, e]));
  return text.split(/\r?\n/).map((line, i) => {
    const entry = entries.get(i + 1);
    if (!entry) return line;
    const looksSecret = findSecrets(entry.value).length > 0 || /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|KEY|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL|WEBHOOK)/i.test(entry.key);
    const exported = /^\s*export\s+/.test(line) ? 'export ' : '';
    return `${exported}${entry.key}=${looksSecret ? `<${entry.key.toLowerCase()}>` : entry.value}`;
  }).join('\n');
}
