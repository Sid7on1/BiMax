import { BrowserWindow, Menu, Tray, dialog, nativeImage, screen } from 'electron';
import type { HostControls, RemoteOperation } from 'desktop-responder';

const STOP_URL = 'bimax-remote-stop://local';
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Main-owned consent; no renderer IPC, script, network or model decision can grant access. */
export class DesktopHostControls implements HostControls {
  private banner: BrowserWindow | null = null;
  private indicator: Tray | null = null;
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private epoch = 0;
  private halted = false;
  private peer: string | null = null;
  private pending = new Set<AbortController>();

  constructor(private readonly stopRemote: () => Promise<unknown>) {}

  async setRemoteSessionActive(active: boolean, peer?: string): Promise<void> {
    if (!active) {
      this.epoch++;
      for (const controller of this.pending) controller.abort();
      this.pending.clear();
      this.banner?.destroy();
      this.indicator?.destroy();
      this.banner = null;
      this.indicator = null;
      this.opening = null;
      this.peer = null;
      return;
    }
    if (this.stopping || this.halted) throw new Error('Remote access was stopped; restart Bimax to enable it again');
    if (!peer || peer.length > 128) throw new Error('Missing remote identity');
    if (this.banner && this.peer === peer) {
      await this.opening;
      return;
    }
    if (this.banner) await this.setRemoteSessionActive(false);
    const epoch = this.epoch;
    const area = screen.getPrimaryDisplay().workArea;
    const banner = new BrowserWindow({
      width: 500, height: 112, x: Math.round(area.x + (area.width - 500) / 2), y: area.y + 16,
      title: 'Bimax remote access', show: false, alwaysOnTop: true, resizable: false,
      minimizable: false, maximizable: false, closable: false, fullscreenable: false,
      skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    this.banner = banner;
    this.peer = peer;
    const stopFromUi = () => { void this.stop().catch(() => {
      if (this.banner && !this.banner.isDestroyed()) void dialog.showMessageBox(this.banner, {
        type: 'error', message: 'Remote Stop could not be confirmed.',
        detail: 'Close Bimax to end remote access, then inspect the task before resuming.',
      });
    }); };
    banner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    banner.webContents.on('will-attach-webview', (event) => event.preventDefault());
    banner.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === STOP_URL) stopFromUi();
    });
    banner.webContents.on('render-process-gone', stopFromUi);
    this.indicator = new Tray(nativeImage.createEmpty());
    this.indicator.setTitle('● Remote');
    this.indicator.setToolTip(`Bimax remote access · ${peer}`);
    this.indicator.setContextMenu(Menu.buildFromTemplate([
      { label: `Remote phone: ${peer}`, enabled: false },
      { label: 'Stop Remote Access', click: stopFromUi },
    ]));
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'">
      <style>body{font:14px system-ui;background:#eee;color:#181818;margin:12px;display:flex;align-items:center;gap:16px}
      p{margin:4px 0;overflow-wrap:anywhere}a{background:#222;color:white;padding:10px;border-radius:7px;text-decoration:none;white-space:nowrap}
      @media(prefers-color-scheme:dark){body{background:#222;color:#eee}a{background:#eee;color:#181818}}</style></head>
      <body><div><strong>Remote access is active</strong><p>Phone: ${escapeHtml(peer)}</p></div>
      <a href="${STOP_URL}">Stop Remote Access</a></body></html>`;
    this.opening = banner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    try {
      await this.opening;
      if (epoch !== this.epoch || this.banner !== banner) throw new Error('Remote session ended');
      banner.showInactive();
    } catch (error) {
      if (this.banner === banner) await this.setRemoteSessionActive(false);
      throw error;
    }
  }

  async authorize(operation: RemoteOperation, signal: AbortSignal): Promise<boolean> {
    const banner = this.banner;
    if (!banner || banner.isDestroyed() || this.stopping || this.halted || signal.aborted || operation.peer !== this.peer ||
        operation.text.length > 16_384) return false;
    const epoch = this.epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.pending.add(controller);
    // Always parent the dialog: unparented macOS dialogs cannot be cancelled by AbortSignal.
    try {
      const answer = await dialog.showMessageBox(banner, {
        type: 'question', title: 'Bimax remote request',
        message: `Allow this ${operation.kind} request from your phone?`,
        detail: `Phone: ${operation.peer}\n\n${operation.text}`,
        buttons: ['Not Now', 'Allow This Request', 'Stop Remote Access'], defaultId: 0, cancelId: 0,
        noLink: true, signal: controller.signal,
      });
      if (answer.response === 2) await this.stop();
      return answer.response === 1 && !controller.signal.aborted && !signal.aborted &&
        epoch === this.epoch && this.banner === banner && !this.stopping;
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(controller);
    }
  }

  /** Local action; reaches the engine without relay availability or an approval response. */
  async stop(): Promise<void> {
    if (this.stopping) { await this.stopping; return; }
    this.halted = true;
    this.epoch++;
    for (const controller of this.pending) controller.abort();
    this.stopping = (async () => {
      await this.stopRemote();
      await this.setRemoteSessionActive(false);
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
