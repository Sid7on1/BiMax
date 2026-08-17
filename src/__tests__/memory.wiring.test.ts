import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteEmbeddingBackend, type EmbeddingTransport } from '../memory/embeddings';
import { VectorStore } from '../memory/vector.store';
import { ProjectMemory, globalProjectMemory } from '../memory/project.memory';
import { AgentPersona } from '../cli/personas/base.persona';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { ChatEvent } from '../core/llm.provider';

/**
 * Wiring, not retrieval quality — memory.retrieval/eval/recall tests grade the pipeline itself.
 * These pin the two paths that made the pipeline DEAD in production while every unit test passed:
 *
 *   1. globalProjectMemory was a bare `new VectorStore()` — no embeddings backend — so persona-level
 *      recall ran BM25-only forever, whatever keys existed, and its whole-file writes raced the
 *      container's store over the same vectors.json.
 *   2. The persona built AgentLoop WITHOUT the memory store, so injectRecall (automatic per-turn
 *      recall) returned at its first guard and never ran outside unit tests.
 */

// A two-axis semantic space: enough structure for a paraphrase to beat lexical matching.
// Keyboard-ish text → [1,0]; colour-ish text → [0,1]; both → the diagonal. Queries and passages
// share the encoder, which is the honest simplification — what matters is that ranking rides on
// meaning-bearing vectors, not shared tokens.
const semanticTransport: EmbeddingTransport = async (_url, init) => {
  const body = JSON.parse(init.body);
  const vec = (text: string): number[] => {
    const kb = /qwerty|keyboard|typing|input|key|letters/i.test(text) ? 1 : 0;
    const colour = /colou?r|palette|hue|tint/i.test(text) ? 1 : 0;
    if (kb && !colour) return [1, 0];
    if (colour && !kb) return [0, 1];
    return [kb, colour];
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: body.input.map((text: string, index: number) => ({ embedding: vec(text), index })) }),
  };
};

const credentials = async () => ({ apiKey: 'k', baseURL: 'https://example.invalid/v1' });

describe('ProjectMemory.useStore — the container upgrade', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-wiring-'));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('recall goes through the upgraded hybrid store, not the bare lexical one', async () => {
    const hybrid = new VectorStore(
      new RemoteEmbeddingBackend({ resolve: credentials, transport: semanticTransport }),
    );
    const pm = new ProjectMemory();
    pm.useStore(hybrid);
    await pm.remember('QWERTY remapping intercepts hardware events before the app sees them', 'convention');

    // Paraphrase with zero shared tokens: lexical cannot rank it, only the dense stage can.
    const query = 'why do my letters arrive wrong when i am entering text';
    const hits = await pm.recall(query);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/QWERTY remapping/);
    expect(hybrid.lastSearchMode().dense).toBe(true);

    // Control: the same note, searched lexically, is invisible — proving the hit above came from
    // the upgrade and not from token overlap.
    const bare = new VectorStore(null);
    expect(await bare.semanticSearch(query, 3, 0.01)).toHaveLength(0);
  });

  test('backingStore exposes the upgraded store for AgentLoop auto-recall', () => {
    const hybrid = new VectorStore(null);
    const pm = new ProjectMemory();
    pm.useStore(hybrid);
    expect(pm.backingStore).toBe(hybrid);
  });
});

// Capture the arguments the persona hands to AgentLoop, without running the real loop.
jest.mock('../core/agent.loop', () => ({
  AgentLoop: class {
    public messages: any[] = [];
    constructor(...args: any[]) { (globalThis as any).__bimaxLoopArgs = args; }
    async *execute(...args: any[]): AsyncGenerator<string> {
      (globalThis as any).__bimaxLoopExecuteArgs = args;
      yield 'ok';
    }
  },
}));

class WiringPersona extends AgentPersona {}

describe('Persona → AgentLoop memory wiring', () => {
  beforeAll(async () => {
    // execute() reads config (context window, iteration caps) before building the loop.
    const { loadConfig } = await import('../cli/config');
    await loadConfig();
  });

  it('passes the singleton’s upgraded store so per-turn auto-recall actually runs', async () => {
    const marked = new VectorStore(null);
    globalProjectMemory.useStore(marked);

    const llm = {
      chat: async function* (): AsyncGenerator<ChatEvent> {},
      chatCompletion: async () => 'DONE',
    } as unknown as LlmAdapter;
    const persona = new WiringPersona({ name: 'wiring', allowedTools: [] } as any, new ToolRegistry(), llm);

    // A substantial prompt, so nothing on the lite/converse lane intercepts it.
    await persona.execute('please summarize the current state of the memory pipeline for me');

    const args = (globalThis as any).__bimaxLoopArgs as any[];
    expect(args).toBeTruthy();
    // 6th positional arg is memoryStore (see AgentLoop constructor). Identity, not shape: the
    // persona must share the container-upgraded index, not build a second one.
    expect(args[5]).toBe(marked);
    expect(args[5]).toBe(globalProjectMemory.backingStore);

    // 7th arg is the SESSION recall-dedup set. The persona is rebuilt-per-turn wrapper: the loop
    // is new every turn, so the set must be the SAME instance across turns or the "never recall
    // the same question twice" guard resets each turn and re-injects the same block.
    await persona.execute('and now a second, different substantial question about the pipeline');
    const secondArgs = (globalThis as any).__bimaxLoopArgs as any[];
    expect(secondArgs[6]).toBeInstanceOf(Set);
    expect(secondArgs[6]).toBe(args[6]);
  });

  it('bridges read-only RAG tools into CU while keeping acting authority on mac_control', async () => {
    const registry = new ToolRegistry();
    const register = (name: string, description: string): void => registry.register({
      name,
      description,
      schema: { type: 'object', properties: {} },
      isDestructive: name === 'BashTool',
      isConcurrencySafe: true,
      execute: async () => 'ok',
    });
    register('mcp__bimax-mac__mac_control', 'NATIVE_ACTOR_SENTINEL');
    register('MemoryQueryTool', 'MEMORY_RAG_SENTINEL');
    register('CodeSearchTool', 'CODE_RAG_SENTINEL');
    register('BashTool', 'MUTATOR_SENTINEL');

    const llm = {
      chat: async function* (): AsyncGenerator<ChatEvent> {},
      chatCompletion: async () => 'DONE',
    } as unknown as LlmAdapter;
    const persona = new WiringPersona({
      name: 'wiring',
      roleDescription: 'test',
      allowedTools: registry.getToolNames(),
    }, registry, llm);

    await persona.execute('open Messages and use the remembered project context');

    const executeArgs = (globalThis as any).__bimaxLoopExecuteArgs as any[];
    const systemPrompt = String(executeArgs[1]);
    const options = executeArgs[2];
    expect(options.requireTool).toBe('mcp__bimax-mac__mac_control');
    expect(options.toolNames).toEqual([
      'mcp__bimax-mac__mac_control',
      'MemoryQueryTool',
      'CodeSearchTool',
    ]);
    expect(systemPrompt).toContain('NATIVE_ACTOR_SENTINEL');
    expect(systemPrompt).toContain('MEMORY_RAG_SENTINEL');
    expect(systemPrompt).toContain('CODE_RAG_SENTINEL');
    expect(systemPrompt).not.toContain('MUTATOR_SENTINEL');
  });
});

describe('session recall dedup across turns', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-dedup-'));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('two loop instances sharing the persona’s set inject the recall block once', async () => {
    // The real loop, not the constructor-mock used by the persona test above.
    const { AgentLoop } = jest.requireActual('../core/agent.loop');
    const store = new VectorStore(null);
    await store.storeDocument('note', 'The permission coach polls once a second and blocks the main process', []);
    const session = new Set<string>();

    const question = 'why does the permission flow feel slow and blocked';
    let injections = 0;
    for (let turn = 0; turn < 2; turn++) {
      const loop = new AgentLoop(fakeLoopLlm(), new ToolRegistry(), undefined, undefined, undefined, store, session);
      const messages: any[] = [{ role: 'user', content: question }];
      (loop as any).messages = messages;
      await (loop as any).injectRecall();
      injections += messages.filter((m) => m.role === 'system' && String(m.content).startsWith('[Recalled memory]')).length;
    }
    // Turn one recalls; turn two is the same normalized question in the same session and must not.
    expect(injections).toBe(1);

    // And without a shared set (the pre-fix world: a fresh loop per turn), it injects twice.
    let unshared = 0;
    for (let turn = 0; turn < 2; turn++) {
      const loop = new AgentLoop(fakeLoopLlm(), new ToolRegistry(), undefined, undefined, undefined, store);
      const messages: any[] = [{ role: 'user', content: question }];
      (loop as any).messages = messages;
      await (loop as any).injectRecall();
      unshared += messages.filter((m) => m.role === 'system' && String(m.content).startsWith('[Recalled memory]')).length;
    }
    expect(unshared).toBe(2);
  });
});

/** The loop never runs in this test — injectRecall needs no model. */
function fakeLoopLlm(): any {
  return { chat: async function* () {} };
}
