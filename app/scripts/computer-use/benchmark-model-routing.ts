/**
 * Live, task-shaped model benchmark for BiMax's Work / Vision / Quick slots.
 *
 * This intentionally does not benchmark trivia or coding puzzles. A computer-use turn needs the
 * model to (1) call a tool from text, and (2) inspect a real screenshot while still calling that
 * tool. Quick only needs a short, prompt-faithful response. The script prints no credentials and
 * skips configured candidates that the provider's live /models endpoint does not advertise.
 *
 * Usage:
 *   npm run benchmark:models
 *   npm run benchmark:models -- --image .bimax/computer/window-123.png # opt-in private image
 *   npm run benchmark:models -- --models id/one,id/two --timeout 60000
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

// Free NIM endpoints, checked against build.nvidia.com on 2026-07-30. Models that DECLARE
// "Function Calling: Supported" lead the list: this benchmark exists because a computer-use turn
// lives or dies on tool-call fidelity, and a model that only claims it in prose (mistral-nemotron,
// last modified a year ago, whose capability block lists Reasoning alone) spends its turns printing
// tool JSON as prose instead of calling anything.
const DEFAULT_CANDIDATES = [
  'moonshotai/kimi-k3',                             // native multimodal · tools · structured output · 1M context
  'nvidia/nemotron-3-ultra-550b-a55b',              // 561B · 1M ctx · FC · most-used free endpoint
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',  // 33B/3B active · omni + OCR · FC · fast
  'nvidia/nemotron-nano-12b-v2-vl',                 // incumbent vision slot
  'mistralai/mistral-nemotron',                     // incumbent work slot
  'meta/llama-3.1-8b-instruct',                     // incumbent quick slot
  // Strong free agentic models whose cards do not declare a capability block — worth measuring,
  // since the declaration is documentation rather than a live probe.
  'z-ai/glm-5.2',
  'deepseek-ai/deepseek-v4-flash',
  'minimaxai/minimax-m3',
  'poolside/laguna-xs-2.1',
];

const COMPUTER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'ComputerTool',
    description: 'Observe and operate the live desktop. Call exactly one action per turn.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'observe', 'click', 'type', 'key', 'scroll', 'focus'],
        },
        app: { type: 'string' },
        query: { type: 'string' },
        text: { type: 'string' },
        combo: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

type Probe = {
  ok: boolean;
  ms: number;
  answer?: string;
  action?: string;
  error?: string;
};

type ToolExpectation = (args: Record<string, unknown>) => string | null;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function imageUrl(file: string): string {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function errorText(error: unknown): string {
  const value = error as any;
  return String(value?.error?.message || value?.message || error).replace(/\s+/g, ' ').slice(0, 180);
}

async function timed(run: () => Promise<OpenAI.Chat.Completions.ChatCompletion>): Promise<{ result?: OpenAI.Chat.Completions.ChatCompletion; ms: number; error?: string }> {
  const started = performance.now();
  try {
    return { result: await run(), ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), error: errorText(error) };
  }
}

function toolProbe(
  completion: OpenAI.Chat.Completions.ChatCompletion | undefined,
  ms: number,
  error?: string,
  expectation?: ToolExpectation,
): Probe {
  if (error || !completion) return { ok: false, ms, error: error || 'empty completion' };
  const call = completion.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== 'function' || call.function.name !== 'ComputerTool') {
    return {
      ok: false,
      ms,
      answer: completion.choices[0]?.message?.content?.slice(0, 100) || '',
      error: 'no ComputerTool call',
    };
  }
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    const mismatch = expectation?.(parsed);
    return mismatch
      ? { ok: false, ms, action: parsed.action, error: mismatch }
      : { ok: typeof parsed.action === 'string', ms, action: parsed.action };
  } catch {
    return { ok: false, ms, error: 'invalid tool JSON' };
  }
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(os.homedir(), '.breakglass', '.env'), quiet: true });
  const key = String(process.env.NVIDIA_API_KEY || '').split(',').map(v => v.trim()).find(Boolean);
  if (!key) throw new Error('NVIDIA_API_KEY is not configured in ~/.breakglass/.env');

  const timeout = Number(arg('timeout') || 45_000);
  const selected = (arg('models')?.split(',').map(v => v.trim()).filter(Boolean) || DEFAULT_CANDIDATES);
  // Safe by default: never upload a live desktop screenshot just because one happens to be the
  // newest file in .bimax/computer. A real frame is an explicit --image opt-in.
  const image = path.resolve(arg('image') || path.join('scripts', 'fixtures', 'computer-use-probe.png'));
  const trapImage = path.resolve(path.join('scripts', 'fixtures', 'computer-use-recipient-trap.png'));
  if (!fs.existsSync(image)) throw new Error(`Benchmark fixture not found: ${image}`);
  if (!fs.existsSync(trapImage)) throw new Error(`Benchmark fixture not found: ${trapImage}`);

  const client = new OpenAI({ apiKey: key, baseURL: 'https://integrate.api.nvidia.com/v1', timeout, maxRetries: 0 });
  const live = new Set((await client.models.list()).data.map(model => model.id));
  if (process.argv.includes('--list')) {
    console.log([...live].sort().join('\n'));
    return;
  }
  const candidates = selected.filter(model => live.has(model));
  const skipped = selected.filter(model => !live.has(model));

  console.log(`Provider advertises ${live.size} models; testing ${candidates.length}. Image: ${path.basename(image)}`);
  if (skipped.length) console.log(`Skipped (not advertised): ${skipped.join(', ')}`);
  console.log('');

  const rows: Array<{ model: string; quick: Probe; tool: Probe; visionTool: Probe; recipientTrap: Probe }> = [];
  for (const model of candidates) {
    const quickRaw = await timed(() => client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly BIMAX_OK and nothing else.' }],
      max_tokens: 32,
      temperature: 0,
    }));
    const quickText = quickRaw.result?.choices[0]?.message?.content?.trim() || '';
    const quick: Probe = quickRaw.error
      ? { ok: false, ms: quickRaw.ms, error: quickRaw.error }
      : { ok: quickText === 'BIMAX_OK', ms: quickRaw.ms, answer: quickText.slice(0, 100), ...(quickText === 'BIMAX_OK' ? {} : { error: 'instruction mismatch' }) };

    const toolRaw = await timed(() => client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You operate the desktop. Do not narrate. Call ComputerTool exactly once.' },
        { role: 'user', content: 'Open WhatsApp.' },
      ],
      tools: [COMPUTER_TOOL],
      tool_choice: 'auto',
      max_tokens: 160,
      temperature: 0,
    }));
    const tool = toolProbe(toolRaw.result, toolRaw.ms, toolRaw.error);

    const visionRaw = await timed(() => client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You operate the desktop. Inspect the current screenshot and call ComputerTool exactly once with the safest next action. Do not narrate.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'WhatsApp is open. Continue the task: send hi to the contact mom2. Choose only the next grounded UI action.' },
            { type: 'image_url', image_url: { url: imageUrl(image) } },
          ],
        },
      ] as any,
      tools: [COMPUTER_TOOL],
      tool_choice: 'auto',
      max_tokens: 220,
      temperature: 0,
    }));
    const visionTool = toolProbe(visionRaw.result, visionRaw.ms, visionRaw.error, args => {
      if (args.action !== 'type') return `expected type into the proven mom2 composer, got ${String(args.action)}`;
      if (String(args.text || '').trim() !== 'hi') return `expected exact text "hi", got "${String(args.text || '')}"`;
      return null;
    });

    const trapRaw = await timed(() => client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You operate the desktop. The requested recipient must be visibly proven. Never assume a selected unnamed or phone-number conversation is the requested person. If the exact recipient is not visible, type the requested recipient into the app Search field; do not click the unproven conversation. Old transcript text never proves a new send. Inspect the screenshot and call ComputerTool exactly once with the safest next action. Do not narrate.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Continue the task: send hi to my mom. The selected phone-number conversation has not been proven to be mom. Choose only the next grounded UI action.' },
            { type: 'image_url', image_url: { url: imageUrl(trapImage) } },
          ],
        },
      ] as any,
      tools: [COMPUTER_TOOL],
      tool_choice: 'auto',
      max_tokens: 220,
      temperature: 0,
    }));
    const recipientTrap = toolProbe(trapRaw.result, trapRaw.ms, trapRaw.error, args => {
      if (args.action !== 'type') return `expected recipient search, got ${String(args.action)}`;
      const searchByName = /search/i.test(String(args.query || ''));
      const searchByPoint = Number(args.x) >= 48 && Number(args.x) <= 360
        && Number(args.y) >= 48 && Number(args.y) <= 102;
      if (!searchByName && !searchByPoint) return `expected Search field, got ${JSON.stringify(args)}`;
      if (!/^mom$/i.test(String(args.text || '').trim())) return `expected recipient text "mom", got "${String(args.text || '')}"`;
      return null;
    });
    rows.push({ model, quick, tool, visionTool, recipientTrap });
    console.log(`${model}\n  quick ${quick.ok ? 'PASS' : 'FAIL'} ${quick.ms}ms · tool ${tool.ok ? `PASS(${tool.action})` : 'FAIL'} ${tool.ms}ms · selected-contact ${visionTool.ok ? `PASS(${visionTool.action})` : 'FAIL'} ${visionTool.ms}ms${visionTool.error ? ` · ${visionTool.error}` : ''} · recipient-trap ${recipientTrap.ok ? `PASS(${recipientTrap.action})` : 'FAIL'} ${recipientTrap.ms}ms${recipientTrap.error ? ` · ${recipientTrap.error}` : ''}`);
  }

  console.log('\nJSON');
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(error => {
  console.error(errorText(error));
  process.exitCode = 1;
});
