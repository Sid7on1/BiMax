import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptItem } from '../renderer/src/engine.state';

/**
 * Muscle memory (backlog FL6): a ⌘2 task that worked, and whose check passed, can be saved as a skill, so the next
 * "do that again for these 40 files" follows what worked instead of starting from nothing.
 *
 * The skill is written from what the task actually did — no model call: its request (when to use it), what it
 * expects as input (the kinds of files it worked on), the steps it took, the checks that proved it, and sample
 * files. It opens with "Check first": when a new input does not match, the task is told not to follow the steps but
 * to work it out afresh and say the skill did not fit. Skills live in ~/.bimax/skills/<name>/SKILL.md, where every
 * Bimax task finds them (src/skills/skill.service.ts); saving again keeps the earlier version.
 */

export interface SkillDraft {
  name: string;
  description: string;
  inputs: string[];
  steps: string[];
  checks: string[];
  samples: string[];
}

/** Tools that only look: they are how the task found its way, not steps worth repeating. */
const LOOKING = new Set(['ReadFileTool', 'GrepTool', 'GlobTool', 'ListDirTool', 'ToolSearchTool', 'SkillTool', 'TodoWriteTool',
  'WebSearchTool', 'WebFetchTool', 'AskUserTool', 'ReadDocumentTool', 'GraphQueryTool', 'GraphContextTool', 'ContextArchiveTool', 'FolderStatusTool', 'WakeTool']);
const MAX_STEPS = 25;

export function skillName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'saved-task';
}

const oneLine = (text: string, max = 140): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A step as a person would write it: the tool and its command, path or plan. */
function stepText(toolName: string, input: string): string {
  let main = input;
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    const pick = args.command ?? args.path ?? args.file_path ?? args.title ?? args.from ?? args.query;
    if (typeof pick === 'string' && pick) main = pick;
    if (Array.isArray(args.moves)) main = `${typeof args.title === 'string' ? `${args.title}: ` : ''}${args.moves.length} moves`;
  } catch { /* not JSON: as it is */ }
  return `${toolName.replace(/Tool$/, '')}: ${oneLine(main)}`;
}

/** The draft of a skill from a finished task: its request, the files it touched, what it did and how it was checked. */
export function skillDraft(input: { title: string; request: string; items: readonly TranscriptItem[]; touched: readonly string[] }): SkillDraft {
  const steps: string[] = [];
  const checks: string[] = [];
  for (const item of input.items) {
    if (item.kind !== 'tool' || item.call.status !== 'success' || item.call.parentId) continue;
    const { toolName } = item.call;
    const raw = String(item.call.input ?? '');
    if (toolName === 'CompletionCheckTool') {
      try {
        const args = JSON.parse(raw) as { checks?: Array<{ kind?: unknown; command?: unknown; path?: unknown; contains?: unknown }> };
        for (const check of args.checks ?? []) {
          if (typeof check.command === 'string') checks.push(`run \`${oneLine(check.command)}\` — it must succeed`);
          else if (typeof check.path === 'string' && check.kind === 'json') checks.push(`${check.path} is valid JSON`);
          else if (typeof check.path === 'string') checks.push(typeof check.contains === 'string' ? `${check.path} contains “${oneLine(check.contains, 60)}”` : `${check.path} exists`);
        }
      } catch { /* an unreadable check is left out */ }
      continue;
    }
    if (LOOKING.has(toolName)) continue;
    const step = stepText(toolName, raw);
    if (steps[steps.length - 1] !== step) steps.push(step);
  }
  const kinds = [...new Set(input.touched.map((file) => path.extname(file).toLowerCase()).filter(Boolean))].sort();
  return {
    name: skillName(input.title),
    description: oneLine(`Use for: ${input.request}`, 200),
    inputs: kinds.length ? [`files like ${kinds.map((k) => `*${k}`).join(', ')}`] : [],
    steps: steps.slice(0, MAX_STEPS),
    checks: [...new Set(checks)],
    samples: [...new Set(input.touched.map((file) => path.basename(file)))].slice(0, 5),
  };
}

/** The SKILL.md the engine reads: frontmatter the skill service parses, then the instructions. */
export function skillMarkdown(draft: SkillDraft, version: number, savedAt: Date): string {
  const lines = [
    '---',
    `name: ${draft.name}`,
    // Quoted: a request often holds ": ", which a plain YAML value cannot (the engine parses this as YAML).
    `description: ${JSON.stringify(draft.description.replace(/\n/g, ' '))}`,
    `version: ${version}`,
    '---',
    '',
    `# ${draft.name}`,
    '',
    `Saved by Bimax on ${savedAt.toISOString().slice(0, 10)} from a task that worked and passed its check (version ${version}).`,
    '',
    '## Check first',
    '',
    draft.inputs.length || draft.samples.length
      ? `This worked on ${[...draft.inputs, ...(draft.samples.length ? [`for example ${draft.samples.join(', ')}`] : [])].join('; ')}. Before following the steps, look at the new input. If it is not like that — other kinds of files, a different layout, anything the steps do not fit — do NOT follow them: work the task out afresh, and say that this skill did not fit and why.`
      : 'Before following the steps, check they fit the new input. If they do not, work the task out afresh, and say that this skill did not fit and why.',
    '',
    '## Steps that worked',
    '',
    ...(draft.steps.length ? draft.steps.map((step, i) => `${i + 1}. ${step}`) : ['1. (No changes were recorded; follow the request.)']),
    '',
    'Adapt paths and names to the new input; ask before changing anything, as usual.',
  ];
  if (draft.checks.length) lines.push('', '## How to check it worked', '', ...draft.checks.map((check) => `- ${check}`), '', 'Register these with CompletionCheckTool before you finish.');
  return `${lines.join('\n')}\n`;
}

/**
 * Write the skill. One already there moves to `versions/v<N>.md` first, so saving again never loses what worked
 * before. Returns where it was written and its version.
 */
export async function saveSkill(skillsDir: string, draft: SkillDraft, savedAt: Date): Promise<{ file: string; version: number }> {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(draft.name)) throw new Error('A skill name is lowercase letters, digits and dashes.');
  const dir = path.join(skillsDir, draft.name);
  const file = path.join(dir, 'SKILL.md');
  let version = 1;
  const previous = await fs.readFile(file, 'utf8').catch(() => null);
  if (previous !== null) {
    const old = Number(/^version:\s*(\d+)/m.exec(previous)?.[1] ?? 1);
    version = old + 1;
    await fs.mkdir(path.join(dir, 'versions'), { recursive: true });
    await fs.writeFile(path.join(dir, 'versions', `v${old}.md`), previous, { flag: 'wx' }).catch(async () => {
      await fs.writeFile(path.join(dir, 'versions', `v${old}-${savedAt.getTime()}.md`), previous);
    });
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, skillMarkdown(draft, version, savedAt), 'utf8');
  return { file, version };
}
