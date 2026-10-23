import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What can this machine run locally, right now, without the network?
 *
 * The honest distinction this module exists to make is between a model that is DOWNLOADED and a
 * model that is SERVABLE. A Hugging Face cache directory is not an endpoint: `models--org--name`
 * on disk means the weights are there, not that anything will answer a chat request. Listing those
 * beside a running Ollama model as though the two were interchangeable is the failure mode here —
 * the user picks one and every request 404s. So each entry carries `servable`, and anything that
 * is not servable carries the reason and the step that would make it servable.
 *
 * Detection is by ASKING THE RUNTIME, never by inferring from a binary on PATH: `ollama` installed
 * with its server stopped serves nothing, and that is a different state from "not installed".
 */

export type LocalRuntimeId = 'ollama' | 'lmstudio' | 'huggingface' | 'llamacpp';

export interface LocalModel {
  /** The id to send as `model` on an OpenAI-compatible request. */
  id: string;
  label: string;
  runtime: LocalRuntimeId;
  /** True only when a running server will accept this id right now. */
  servable: boolean;
  sizeBytes?: number;
  detail: string;
}

export interface LocalRuntime {
  id: LocalRuntimeId;
  label: string;
  /** The runtime is present on the machine (binary or data directory). */
  installed: boolean;
  /** A server is answering, so its models can be used immediately. */
  running: boolean;
  /** OpenAI-compatible base URL, when the runtime exposes one. */
  baseURL?: string;
  models: LocalModel[];
  /** What the user would do next, in plain language. Empty when nothing is needed. */
  hint: string;
}

/**
 * Resolved per call, never captured at import. A module-level snapshot binds the home directory to
 * whenever this file first happened to load, which is both wrong if HOME changes and untestable —
 * a test that points HOME at a fixture directory would still scan the developer's real cache.
 *
 * $HOME is read before os.homedir() because they disagree under a sandboxed process.env: libuv
 * reads the real environ, so an in-process assignment to process.env.HOME is invisible to
 * os.homedir() there while being exactly what the caller meant.
 */
const home = (): string => process.env.HOME || os.homedir();

async function getJson(url: string, timeoutMs = 1500): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function onPath(cmd: string): boolean {
  try {
    return existsSync(`/usr/local/bin/${cmd}`) || existsSync(`/opt/homebrew/bin/${cmd}`) || existsSync(`/usr/bin/${cmd}`);
  } catch {
    return false;
  }
}

function bytesOf(dir: string, depth = 0, seen = new Set<string>()): number {
  // Bounded: a model cache can hold tens of thousands of files and this runs on a UI request.
  if (depth > 4) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        // The Hugging Face cache stores every real file once under `blobs/` and links to it from
        // `snapshots/`. Classifying by dirent type therefore reports 0 bytes for every model,
        // because the snapshot entries are symlinks — neither isFile() nor isDirectory(). statSync
        // follows the link, and the inode set stops the shared blob being counted twice.
        const st = statSync(full);
        if (st.isDirectory()) total += bytesOf(full, depth + 1, seen);
        else if (st.isFile()) {
          const key = `${st.dev}:${st.ino}`;
          if (!seen.has(key)) { seen.add(key); total += st.size; }
        }
      } catch { /* unreadable or broken link */ }
    }
  } catch { /* unreadable dir */ }
  return total;
}

async function detectOllama(): Promise<LocalRuntime> {
  const dataDir = path.join(home(), '.ollama');
  const installed = onPath('ollama') || existsSync(dataDir);
  const baseURL = 'http://localhost:11434/v1';
  const tags = await getJson('http://localhost:11434/api/tags');
  const running = tags !== null;

  const models: LocalModel[] = [];
  if (running) {
    const list = (tags as { models?: { name?: string; size?: number }[] }).models ?? [];
    for (const m of list) {
      if (!m.name) continue;
      models.push({
        id: m.name, label: m.name, runtime: 'ollama', servable: true,
        sizeBytes: m.size, detail: 'Served by the running Ollama server.',
      });
    }
  }

  let hint = '';
  if (!installed) hint = 'Not installed. `brew install ollama`, then `ollama serve`.';
  else if (!running) hint = 'Installed but its server is not answering. Run `ollama serve`.';
  else if (models.length === 0) hint = 'Running, but no models are downloaded. Pull one, e.g. `ollama pull qwen2.5-coder:7b`.';

  return { id: 'ollama', label: 'Ollama', installed, running, baseURL: running ? baseURL : undefined, models, hint };
}

async function detectLmStudio(): Promise<LocalRuntime> {
  const dataDir = path.join(home(), '.lmstudio');
  const installed = existsSync(dataDir) || existsSync('/Applications/LM Studio.app');
  const baseURL = 'http://localhost:1234/v1';
  const listed = await getJson('http://localhost:1234/v1/models');
  const running = listed !== null;

  const models: LocalModel[] = [];
  if (running) {
    for (const m of (listed as { data?: { id?: string }[] }).data ?? []) {
      if (!m.id) continue;
      models.push({
        id: m.id, label: m.id, runtime: 'lmstudio', servable: true,
        detail: 'Served by the running LM Studio server.',
      });
    }
  }

  let hint = '';
  if (!installed) hint = 'Not installed.';
  else if (!running) hint = 'Installed, but its local server is off. Start it from LM Studio → Developer → Start Server.';
  else if (models.length === 0) hint = 'Server running with no model loaded. Load one in LM Studio.';

  return { id: 'lmstudio', label: 'LM Studio', installed, running, baseURL: running ? baseURL : undefined, models, hint };
}

/**
 * The Hugging Face cache. These are weights on disk, NOT an endpoint — every entry is reported
 * `servable: false` on purpose, because nothing will answer a request for them until a server is
 * pointed at them.
 */
function detectHuggingFace(): LocalRuntime {
  const hub = path.join(home(), '.cache', 'huggingface', 'hub');
  const installed = existsSync(hub);
  const models: LocalModel[] = [];

  if (installed) {
    let entries: string[] = [];
    try { entries = readdirSync(hub).filter(e => e.startsWith('models--')); } catch { /* unreadable */ }
    for (const entry of entries.slice(0, 200)) {
      const repo = entry.replace(/^models--/, '').replace(/--/g, '/');
      const sizeBytes = bytesOf(path.join(hub, entry));
      // A `models--org--name` directory is created before anything is fetched, and an aborted or
      // metadata-only download leaves the shell behind. Measured on this machine: six such entries
      // at 4 KB each, 24 KB total — no weights at all. Listing those as "downloaded models" is the
      // exact false positive this report exists to avoid, so the state is named rather than hidden.
      const hasWeights = sizeBytes > 1_000_000;
      models.push({
        id: repo, label: repo, runtime: 'huggingface', servable: false, sizeBytes,
        detail: hasWeights
          ? 'Weights are cached on disk. Serve them (llama.cpp, vLLM, LM Studio) before they can answer requests.'
          : 'Cache entry only — no weights downloaded. Nothing to serve.',
      });
    }
  }

  const withWeights = models.filter(m => (m.sizeBytes ?? 0) > 1_000_000).length;
  return {
    id: 'huggingface', label: 'Hugging Face cache', installed, running: false,
    models,
    hint: !installed
      ? 'No Hugging Face cache on this machine.'
      : withWeights === 0
        ? `${models.length} cache entr${models.length === 1 ? 'y' : 'ies'}, none with weights downloaded.`
        : 'Downloaded weights only. Nothing here answers a request until a server is pointed at it.',
  };
}

function detectLlamaCpp(): LocalRuntime {
  const installed = onPath('llama-server') || onPath('llama-cli');
  return {
    id: 'llamacpp', label: 'llama.cpp', installed, running: false, models: [],
    hint: installed
      ? 'Installed. Start `llama-server --port 8080` and add it as a provider with that base URL.'
      : 'Not installed.',
  };
}

export interface LocalModelReport {
  runtimes: LocalRuntime[];
  /** Every model that can be used right now, across runtimes. */
  servable: LocalModel[];
  scannedAt: string;
}

export async function discoverLocalModels(): Promise<LocalModelReport> {
  const [ollama, lmstudio] = await Promise.all([detectOllama(), detectLmStudio()]);
  const runtimes = [ollama, lmstudio, detectHuggingFace(), detectLlamaCpp()];
  return {
    runtimes,
    servable: runtimes.flatMap(r => r.models.filter(m => m.servable)),
    scannedAt: new Date().toISOString(),
  };
}
