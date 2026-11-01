import { Menu, Tray, dialog, nativeImage } from 'electron';
import type { HostControls, RemoteOperation } from 'desktop-responder';

/** The human-verified paired phone is the grant. Ordinary work needs no Mac-side prompt. */
export class DesktopHostControls implements HostControls {
  private indicator: Tray | null = null;
  private peer: string | null = null;
  private halted = false;
  private stopping: Promise<void> | null = null;
  constructor(private readonly stopRemote: () => Promise<unknown>) {}

  async setRemoteSessionActive(active: boolean, peer?: string): Promise<void> {
    if (!active) {
      this.peer = null;
      this.indicator?.destroy();
      this.indicator = null;
      return;
    }
    if (this.halted || this.stopping) throw new Error('Remote access was stopped; restart Bimax to enable it again');
    if (!peer || peer.length > 128) throw new Error('Missing remote identity');
    if (this.peer === peer && this.indicator) return;
    this.indicator?.destroy();
    this.peer = peer;
    const tray = new Tray(nativeImage.createEmpty());
    this.indicator = tray;
    tray.setTitle('Phone');
    tray.setToolTip('Bimax · Your paired phone is connected');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Bimax phone connection', enabled: false },
      { label: `Paired phone: ${peer}`, enabled: false },
      { type: 'separator' },
      { label: 'Stop Phone Access', click: () => { void this.stop().catch(() => {
        void dialog.showMessageBox({ type: 'error', message: 'Phone access could not be stopped.', detail: 'Close Bimax to end the connection, then inspect the task before resuming.' });
      }); } },
    ]));
  }

  async authorize(operation: RemoteOperation, signal: AbortSignal): Promise<boolean> {
    // Responder independently requires the pinned peer and a current authenticated Noise session.
    // Pairing/revocation/Stop determine authority; model content never grants it.
    return !signal.aborted && !this.halted && !this.stopping && !!this.indicator &&
      !!this.peer && operation.peer === this.peer && operation.text.length <= 32 * 1024;
  }

  /** Main-owned Stop remains available even without the network or a phone response. */
  async stop(): Promise<void> {
    if (this.stopping) { await this.stopping; return; }
    this.halted = true;
    this.peer = null;
    this.stopping = (async () => {
      try { await this.stopRemote(); }
      finally { await this.setRemoteSessionActive(false); }
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
