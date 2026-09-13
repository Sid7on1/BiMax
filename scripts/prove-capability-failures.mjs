#!/usr/bin/env node
/** Offline end-to-end fault injection against a BUILT engine. Uses a loopback fixture provider,
 * isolated config/project, no user keys, and no diagnostic command. A normal CodeSearchTool turn
 * must proactively emit a visible capability message before its final answer. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.argv[2] || path.join(repo, '.engine-local/bimax-engine-no-silence'));
const evidence = path.resolve(process.argv[3] || path.join(repo, 'docs/product-reset/evidence/capability-failures'));
fs.mkdirSync(evidence, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(evidence, runId); fs.mkdirSync(runDir);
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const record = { schema: 'bimax.capability-fault-proof.v1', startedAt: new Date().toISOString(),
  binarySha256: hash(binary), scriptSha256: hash(fileURLToPath(import.meta.url)),
  runtime: { platform: process.platform, arch: process.arch, totalMemoryBytes: os.totalmem() },
  provider: 'controlled loopback HTTP fixture', model: 'mock', cases: [], status: 'fail' };

async function one(name, brokenStage, status) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-capability-proof-'));
  const configDir = path.join(fixture, 'config'); fs.mkdirSync(configDir);
  const project = path.join(fixture, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'sentinel.ts'), 'export function sentinelAlpha() { return "fixture"; }\n');
  fs.writeFileSync(path.join(project, 'related.ts'), 'export function sentinelBeta() { return "sentinelAlpha related fixture"; }\n');
  const config = path.join(configDir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ provider: 'ollama', model: 'mock', liteModel: 'mock', onboardingComplete: true, autoIndex: false, autoResumeAgents: false, autoContinueOutcome: false }));
  const configBefore = hash(config);
  let failureAt = null; let noticeAt = null; let finalAt = null; let child;
  let parsedFrames = 0; let invalidFrames = 0; let embedCalls = 0; let rerankCalls = 0;
  const frames = []; const start = performance.now();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    if (req.url.endsWith('/embeddings')) {
      embedCalls++;
      if (brokenStage === 'embeddings') { failureAt ??= performance.now() - start; res.statusCode = status; return res.end('{}'); }
      return res.end(JSON.stringify({ data: data.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    }
    if (req.url.endsWith('/rerank')) {
      rerankCalls++;
      if (brokenStage === 'reranking') { failureAt ??= performance.now() - start; res.statusCode = status; return res.end('{}'); }
      return res.end(JSON.stringify({ results: (data.documents || data.passages || []).map((_, index) => ({ index, relevance_score: 1 / (index + 1) })) }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const hasResult = data.messages?.some(m => m.role === 'tool');
      const delta = hasResult ? { content: 'Fixture search finished.' } : {
        tool_calls: [{ index: 0, id: 'search-fixture', type: 'function', function: { name: 'CodeSearchTool', arguments: '{"query":"sentinelAlpha"}' } }],
      };
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: hasResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    BIMAX_BREAKGLASS_DIR: configDir, BIMAX_HEADLESS: '1', BIMAX_AUTO_INDEX: '0',
    BIMAX_MCP_BOOT_DELAY_MS: '3600000', BIMAX_AUTO_RESUME_AGENTS: '0', BIMAX_AUTO_CONTINUE_OUTCOME: '0',
    BIMAX_CODE_INDEX: '1', BIMAX_CODE_INDEX_REMOTE: '1', BIMAX_EMBED_BASE_URL: url,
    BIMAX_EMBED_MODEL: 'fixture', BIMAX_EMBED_DIM: '2', BIMAX_RERANK_URL: `${url}/rerank`,
    BGW_BASE_URL: url, BGW_MODEL: 'mock', BGW_LITE_MODEL: 'mock', BGW_PROVIDER: 'ollama',
    BGW_CAP_PLAIN_CONTENT: 'true', BIMAX_RECORDER: '0', BIMAX_MAX_ITERATIONS: '4',
  };
  const stderr = fs.createWriteStream(path.join(runDir, `${name}.stderr.log`));
  const raw = fs.createWriteStream(path.join(runDir, `${name}.ndjson`));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      child = spawn(binary, [], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.pipe(stderr); child.on('error', reject);
      let buffer = ''; let sent = false;
      child.stdout.on('data', chunk => {
        raw.write(chunk); buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message; try { message = JSON.parse(line); parsedFrames++; } catch { invalidFrames++; continue; }
          frames.push(message);
          if (message.t === 'ready' && !sent) {
            sent = true;
            child.stdin.write(JSON.stringify({ t: 'input', text: 'Find sentinelAlpha with code search.' }) + '\n');
          }
          if (message.args?.[0]?.payload?.capabilityStatus?.id === brokenStage && noticeAt === null) {
            noticeAt = performance.now() - start;
            console.error(`[${name}] CAUGHT: ${message.args[0].content}`);
          }
          if (message.t === 'event' && message.name === 'message' && message.args?.[0]?.role === 'assistant'
            && message.args[0].content.includes('Fixture search finished')) {
            finalAt = performance.now() - start; resolve();
          }
        }
      });
      child.on('exit', code => { if (finalAt === null) reject(new Error(`Engine exited before final answer: ${code}`)); });
      timer = setTimeout(() => reject(new Error('No completed search turn within 45 seconds')), 45_000);
    });
  } catch (error) {
    record.cases.push({ name, status: 'fail', error: String(error), embedCalls, rerankCalls, failureAt, noticeAt, finalAt, parsedFrames, invalidFrames });
    return;
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(killTimer);
    }
    raw.end(); stderr.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Keep only proof artifacts, never the temporary config or project.
    const configAfter = fs.existsSync(config) ? hash(config) : null;
    record.configUnchanged = record.configUnchanged !== false && configAfter === configBefore;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  const matched = frames.find(m => m.args?.[0]?.payload?.capabilityStatus?.id === brokenStage);
  const passed = failureAt !== null && noticeAt !== null && noticeAt >= failureAt && noticeAt < finalAt
    && invalidFrames === 0 && matched.args[0].content.includes(brokenStage === 'embeddings' ? 'keywords only' : 'first-stage order');
  record.cases.push({ name, status: passed ? 'pass' : failureAt === null ? 'invalid' : 'fail', configBefore, injectedHttpStatus: status, embedCalls, rerankCalls,
    failureAt, noticeAt, detectionMs: noticeAt === null ? null : noticeAt - failureAt, finalAt, parsedFrames, invalidFrames });
}
try {
  await one('embedding-410', 'embeddings', 410);
  await one('reranking-404', 'reranking', 404);
  record.status = record.cases.length === 2 && record.cases.every(c => c.status === 'pass') && record.configUnchanged ? 'pass' : 'fail';
} finally {
  record.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: record.status, artifact: path.join(runDir, 'result.json'), cases: record.cases }, null, 2));
}
if (record.status !== 'pass') process.exitCode = 1;
