/**
 * Lifecycle for the resident visual-retrieval encoder.
 *
 * The scoring half lives in `visual.retrieval.ts` and is pure. This is the half that owns a process:
 * provisioning the venv, starting the server, waiting for the weights, and being honest when none of
 * that is possible.
 *
 * ## Opt-in, like the converter and for a bigger reason
 *
 * ColQwen2 is a 2B-parameter vision-language model. The venv pulls torch, and the weights are
 * gigabytes. Provisioning that because a user dropped a scanned PDF would be indefensible on a
 * metered link, and on a nearly-full disk it is a failed ingest and a broken machine. So nothing
 * here installs anything unless {@link installVisualRetrieval} is called, and every read path
 * degrades to the text lane, which still works.
 *
 * ## One owner per process
 *
 * `headroomProxy.ts` carries a cross-process lockfile so two engines share one sidecar on a fixed
 * port. This does not: it takes an ephemeral port when its default is busy, so two engines get two
 * encoders rather than colliding. That is a deliberate simplification and a real cost — two copies
 * of a multi-gigabyte model — so the default port is checked first and the reuse path is the obvious
 * next change, not an oversight.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils';
import { PythonVenv } from '../sidecar/python.env';
import { findFreePort, httpGetOk, httpPostJson, isPortFree, waitReady } from '../sidecar/ports';

const DEFAULT_PORT = Number(process.env.BIMAX_COLQWEN_PORT) || 8790;

const VENV = new PythonVenv({
  name: 'colqwen',
  // sentence-transformers v6 is the supported path: colpali-engine is deprecated by its own authors
  // in favour of `MultiVectorEncoder`, which ships the ColPali-family configs.
  packages: ['sentence-transformers>=6', 'torch', 'fastapi', 'uvicorn', 'pillow'],
  imports: ['sentence_transformers', 'fastapi', 'uvicorn'],
});

export function colqwenVenv(): PythonVenv {
  return VENV;
}

export function serverScript(): string {
  return path.join(__dirname, 'native', 'colqwen_server.py');
}

export class VisualRetrievalUnavailable extends Error {
  constructor(reason: string) {
    super(
      `Visual retrieval is not available (${reason}). Pages were not indexed as images — rather `
      + 'than fall back to OCR silently and report a recall number the transcription cannot '
      + 'support. Install it with "/sidecars install visual" (a multi-gigabyte model, downloaded '
      + 'once). Text retrieval is unaffected and continues to work.',
    );
    this.name = 'VisualRetrievalUnavailable';
  }
}

let child: ChildProcess | null = null;
let port = DEFAULT_PORT;
let starting: Promise<boolean> | null = null;

export function visualRetrievalPort(): number {
  return port;
}

export function isVisualRetrievalRunning(): boolean {
  return child !== null && !child.killed;
}

/** Installed? Never provisions — a probe that installs cannot be called from a read path. */
export async function visualRetrievalAvailable(): Promise<boolean> {
  if (process.env.BIMAX_DISABLE_VISUAL_RETRIEVAL === '1') return false;
  if (!fs.existsSync(serverScript())) return false;
  return VENV.provisioned();
}

/** Provision the venv. Slow, loud, and only because a human asked. */
export async function installVisualRetrieval(): Promise<boolean> {
  if (!fs.existsSync(serverScript())) {
    Logger.warn(`[colqwen] server script missing at ${serverScript()}`);
    return false;
  }
  return VENV.ensure();
}

/**
 * Start the encoder if it is not already up. Idempotent; concurrent callers share one attempt.
 *
 * The readiness budget is generous because the first start loads gigabytes from disk — and the
 * server deliberately loads BEFORE it binds, so a socket that accepts is a model that is ready
 * rather than one still warming.
 */
export async function ensureVisualRetrieval(readyTimeoutMs = 600_000): Promise<boolean> {
  if (await httpGetOk(port, '/readyz', 800)) return true;
  if (starting) return starting;

  starting = (async () => {
    try {
      if (!(await visualRetrievalAvailable())) return false;

      port = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await findFreePort();
      child = spawn(VENV.python, [serverScript(), '--port', String(port)], {
        env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });
      child.stderr?.on('data', (buffer: Buffer) => {
        const line = buffer.toString().trim();
        if (/error|traceback|failed/i.test(line)) Logger.warn(`[colqwen] ${line.slice(0, 300)}`);
      });
      child.on('exit', (code) => {
        child = null;
        if (code) Logger.warn(`[colqwen] encoder exited (code ${code}).`);
      });
      // Do not let an optional sidecar keep a short-lived CLI invocation alive.
      (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
      child.unref();

      if (!(await waitReady(port, '/readyz', readyTimeoutMs))) {
        Logger.warn('[colqwen] encoder did not become ready in time.');
        stopVisualRetrieval();
        return false;
      }
      Logger.info(`[colqwen] visual retrieval ready on 127.0.0.1:${port}`);
      return true;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

export function stopVisualRetrieval(): void {
  if (child && !child.killed) child.kill('SIGTERM');
  child = null;
}

interface EmbedResponse {
  vectors: number[][][];
  dim: number;
}

/**
 * Embed queries. Returns one token-vector set per input, in order.
 *
 * Queries are never pooled server-side: they are already short, and collapsing query tokens changes
 * what was asked rather than what was stored.
 */
export async function embedQueries(texts: string[], timeoutMs = 60_000): Promise<number[][][]> {
  if (texts.length === 0) return [];
  if (!(await ensureVisualRetrieval())) throw new VisualRetrievalUnavailable('the encoder is not running');
  const response = await httpPostJson<EmbedResponse>(port, '/embed/queries', { texts }, timeoutMs);
  if (!Array.isArray(response?.vectors) || response.vectors.length !== texts.length) {
    // A short batch would attach every query's vectors to the wrong text — the same ordering trap
    // `embeddings.ts` guards with `index`, and here there is no index to sort by.
    throw new Error(`encoder returned ${response?.vectors?.length ?? 0} query embeddings for ${texts.length} queries`);
  }
  return response.vectors;
}

/** Embed page images. One patch-vector set per path, in order. */
export async function embedPages(imagePaths: string[], timeoutMs = 600_000): Promise<number[][][]> {
  if (imagePaths.length === 0) return [];
  if (!(await ensureVisualRetrieval())) throw new VisualRetrievalUnavailable('the encoder is not running');
  const response = await httpPostJson<EmbedResponse>(port, '/embed/pages', { paths: imagePaths }, timeoutMs);
  if (!Array.isArray(response?.vectors) || response.vectors.length !== imagePaths.length) {
    throw new Error(`encoder returned ${response?.vectors?.length ?? 0} page embeddings for ${imagePaths.length} pages`);
  }
  return response.vectors;
}
