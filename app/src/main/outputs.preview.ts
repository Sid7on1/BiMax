import { WebContentsView, ipcMain, session, type BrowserWindow } from 'electron';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { previewBounds, previewHtml } from './preview.policy';
import type { OutputDocument, PreviewEvent } from '../shared/outputs';

export function compilePreview(content: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Preview compilation cancelled.'));
      return;
    }
    let settled = false;
    const runtimeRoot=path.join(__dirname,'../..').replace(/app\.asar(?=\/|$)/,'app.asar.unpacked');
    const binary=path.join(runtimeRoot,'node_modules','@esbuild',`${process.platform}-${process.arch}`,process.platform==='win32'?'esbuild.exe':'bin/esbuild');
    const worker = new Worker(path.join(__dirname, 'preview.compiler.worker.js'), {
      workerData: { content, resolveDir:runtimeRoot },
      env:{...process.env,ESBUILD_BINARY_PATH:binary},
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Preview compilation timed out.'));
    }, 8000);
    const cancel = () => {
      finish();
      reject(new Error('Preview compilation cancelled.'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const finish = () => {
      settled = true;
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once('message', (value) => {
      finish();
      value.error ? reject(new Error(value.error)) : resolve(value.code);
    });
    worker.once('error', (error) => {
      finish();
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        signal?.removeEventListener('abort', cancel);
        reject(new Error(`Preview compiler stopped (${code}).`));
      }
    });
  });
}
/** One memory-only guest per window, never a trusted renderer or engine. */
export class OutputPreview {
  private generation = 0;
  private compilation?: AbortController;
  private denyProxy?: Promise<Server>;
  private proxy(): Promise<Server> {
    return (this.denyProxy ??= new Promise((resolve, reject) => {
      // WebRTC/TURN TCP is not a Fetch request. Force it through a loopback sink as well.
      const server = createServer((socket) => socket.destroy());
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    }));
  }
  revision() {
    return this.generation;
  }
  reserve() {
    this.stop();
    return this.generation;
  }
  private readonly configuredSessions = new WeakSet<Electron.Session>();
  private guest?: {
    view: WebContentsView;
    window: BrowserWindow;
    token: string;
    owner: string;
    cleanup: () => void;
    call?: (name: string, args: unknown) => Promise<any>;
    cancel?: () => void;
  };
  constructor(private emit: (event: PreviewEvent) => void) {
    ipcMain.handle('outputs:app-call', async (event, name, args) => {
      const guest = this.guest;
      if (
        !guest?.call ||
        event.sender !== guest.view.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.senderFrame.top ||
        typeof name !== 'string' ||
        name.length > 200 ||
        JSON.stringify(args).length > 64_000
      )
        throw new Error('Tool UI request refused.');
      return guest.call(name, args);
    });
  }
  async startApp(
    window: BrowserWindow,
    owner: string,
    data: any,
    bounds: unknown,
    call: (name: string, args: unknown) => Promise<any>,
    cancel: () => void,
  ) {
    if (!data || typeof data.html !== 'string' || data.html.length > 192 * 1024)
      throw new Error('Invalid tool UI resource.');
    const generation = this.generation;
    const bundle = await readFile(path.join(__dirname, '../preview/mcp.host.js'), 'utf8');
    if (generation !== this.generation || window.isDestroyed()) throw new Error('Tool UI was closed.');
    const body = `<script id="tool-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`;
    return this.start(
      window,
      owner,
      { record: { format: 'html' }, state: 'available', content: body } as OutputDocument,
      bounds,
      call,
      cancel,
    );
  }
  async start(
    window: BrowserWindow,
    owner: string,
    document: OutputDocument,
    bounds: unknown,
    call?: (name: string, args: unknown) => Promise<any>,
    cancel?: () => void,
  ): Promise<string> {
    this.stop();
    const generation = this.generation;
    if (document.state !== 'available' || !['html', 'react'].includes(document.record.format))
      throw new Error('This saved output cannot run.');
    const token = randomUUID();
    let body = document.content;
    if (document.record.format === 'react') {
      const controller = new AbortController();
      this.compilation = controller;
      let code: string;
      try {
        code = await compilePreview(document.content, controller.signal);
      } finally {
        if (this.compilation === controller) this.compilation = undefined;
      }
      body = `<div id="root"></div><script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
    }
    if (generation !== this.generation || window.isDestroyed()) throw new Error('Preview was superseded.');
    const isolated = session.fromPartition(`bimax-preview-window-${window.id}`, { cache: false });
    const denyProxy = await this.proxy(),
      address = denyProxy.address();
    if (!address || typeof address === 'string') throw new Error('Preview network guard unavailable.');
    await isolated.setProxy({
      proxyRules: `http://127.0.0.1:${address.port}`,
      proxyBypassRules: '<-loopback>',
    });
    await isolated.closeAllConnections();
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (!this.configuredSessions.has(isolated)) {
      isolated.on('will-download', (event) => event.preventDefault());
      this.configuredSessions.add(isolated);
    }
    await isolated.clearStorageData();
    if (generation !== this.generation || window.isDestroyed()) throw new Error('Preview was superseded.');
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith('data:') }),
    );
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
        navigateOnDragDrop: false,
        ...(call ? { preload: path.join(__dirname, '../preload/preview.js') } : {}),
      },
    });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('will-redirect', (event) => event.preventDefault());
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    let lines = 0;
    view.webContents.on('console-message', (event) => {
      if (lines++ < 200)
        this.emit({
          token,
          ownerThreadId: owner,
          level: event.level === 'error' ? 'error' : 'log',
          text: event.message.slice(0, 2000),
        });
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      this.emit({ token, ownerThreadId: owner, level: 'error', text: `Preview stopped: ${details.reason}` });
      this.stop();
    });
    const teardown = () => this.stop();
    window.once('closed', teardown);
    window.webContents.once('did-start-navigation', teardown);
    this.guest = {
      view,
      window,
      token,
      owner,
      call,
      cancel,
      cleanup: () => {
        window.removeListener('closed', teardown);
        window.webContents.removeListener('did-start-navigation', teardown);
      },
    };
    window.contentView.addChildView(view);
    this.resize(token, owner, bounds);
    try {
      await view.webContents.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(call ? previewHtml(body).replace("frame-src 'none'", 'frame-src about:') : previewHtml(body))}`,
      );
    } catch (error) {
      if (this.guest?.token === token) this.stop();
      throw error;
    }
    if (this.guest?.token !== token) throw new Error('Preview closed.');
    this.emit({ token, ownerThreadId: owner, level: 'state', text: 'Running offline · isolated browser' });
    return token;
  }
  resize(token: string, owner: string, raw: unknown) {
    const guest = this.guest;
    if (!guest || guest.token !== token || guest.owner !== owner) return false;
    const [width, height] = guest.window.getContentSize();
    guest.view.setBounds(previewBounds(raw, width, height));
    return true;
  }
  stop(token?: string, owner?: string) {
    if (token && (this.guest?.token !== token || this.guest?.owner !== owner)) return false;
    this.generation++;
    this.compilation?.abort();
    this.compilation = undefined;
    const guest = this.guest;
    this.guest = undefined;
    if (guest) {
      guest.cancel?.();
      guest.cleanup();
      if (!guest.window.isDestroyed()) guest.window.contentView.removeChildView(guest.view);
      if (!guest.view.webContents.isDestroyed()) guest.view.webContents.close();
      this.emit({ token: guest.token, ownerThreadId: guest.owner, level: 'state', text: 'Stopped' });
    }
    return true;
  }
}
