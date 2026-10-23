import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Worker } from 'node:worker_threads';
import { createMemoryRetrieval } from '../memory/retrieval.factory';
import { ChainedReranker } from '../memory/rerank';

test.each([false, true])('real worker uses configured local embeddings; chat key available=%s', async chat => {
  const requests: { url: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', data => { raw += data; });
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push({ url: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/embed/v1/embeddings') {
        res.end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
      } else if (req.url === '/chat/v1/rerank') {
        res.end(JSON.stringify({ results: body.documents.map((_text: string, index: number) => ({ index, relevance_score: 1 - index })) }));
      } else { res.statusCode = 500; res.end('{}'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bimax-retrieval-factory-'));
  const worker = new Worker(path.join(__dirname, 'fixtures/memory.retrieval.worker.cjs'), {
    workerData: { file: path.join(dir, 'vectors.json'), chatURL: chat ? `${base}/chat/v1` : null,
      settings: { embeddingBaseURL: `${base}/embed/v1`, embeddingModel: 'fixture-local', embeddingDimensions: 384, rerankModel: 'fixture-rerank' } },
    env: { ...process.env, BIMAX_STATE_DIR: dir },
  });
  try {
    const observed = await new Promise<any>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(observed.error).toBeUndefined();
    expect(observed.before).toBe(0);
    expect(observed.ids.sort()).toEqual(['one', 'two']);
    expect(observed.mode).toEqual({ lexical: true, dense: true, reranked: chat });
    expect(observed.embeddingSpace).toBe('fixture-local@2');
    expect(observed.keyReads).toBe(1); // Reranking alone resolves the independent chat credentials.
    expect(requests.filter(r => r.url.endsWith('/embeddings')).map(r => r.url)).toEqual(['/embed/v1/embeddings', '/embed/v1/embeddings']);
    expect(requests.filter(r => r.url.startsWith('/chat'))).toHaveLength(chat ? 1 : 0);
    expect(requests.filter(r => r.url.endsWith('/embeddings')).every(r => r.body.model === 'fixture-local' && !('input_type' in r.body))).toBe(true);
  } finally {
    await worker.terminate();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test('host and worker both construct retrieval through the shared factory', async () => {
  const root = path.resolve(__dirname, '../..');
  const [host, worker] = await Promise.all(['src/core/container.ts', 'src/engine/worker.entry.ts'].map(file => fs.readFile(path.join(root, file), 'utf8')));
  expect(host).toContain('createMemoryRetrieval({');
  expect(worker).toContain('createMemoryRetrieval({');
  expect(worker).not.toContain('new RemoteEmbeddingBackend(');
});

test('local reranker stays opt-in and has identical host/worker composition', () => {
  const resolveChat = async () => null;
  const enabled = createMemoryRetrieval({ resolveChat, localRerank: true });
  const disabled = createMemoryRetrieval({ resolveChat, localRerank: false });
  expect(enabled.localReranker).not.toBeNull();
  expect(enabled.reranker).toBeInstanceOf(ChainedReranker);
  expect(disabled.localReranker).toBeNull();
  expect(disabled.reranker).not.toBeInstanceOf(ChainedReranker);
});
