/**
 * Embedded Browser Manager for Bimax Desktop.
 *
 * Implements an all-in-one embedded browser inside Bimax for Mac (similar to ChatGPT Desktop / Aside)
 * using Electron WebContentsView with persistent session partitioning.
 */

import { BrowserWindow, session, WebContentsView } from 'electron';
import { CdpStealthBridge } from './cdp.stealth.bridge';

export interface EmbeddedTab {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isAgentActive: boolean;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class EmbeddedBrowserManager {
  private window: BrowserWindow | null = null;
  private tabs = new Map<string, { view: WebContentsView; tab: EmbeddedTab }>();
  private activeTabId: string | null = null;
  private currentBounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  private isVisible = false;

  constructor(private partitionName = 'persist:bimax-browser') {}

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  private getSession() {
    return session.fromPartition(this.partitionName);
  }

  createTab(initialUrl = 'https://google.com'): EmbeddedTab {
    const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const sess = this.getSession();

    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });

    const tab: EmbeddedTab = {
      id,
      url: initialUrl,
      title: 'New Tab',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
      isAgentActive: false,
    };

    this.tabs.set(id, { view, tab });

    // Setup event listeners
    const wc = view.webContents;

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this.broadcastState();
    });

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      tab.url = wc.getURL();
      tab.title = wc.getTitle() || tab.url;
      this.broadcastState();
    });

    wc.on('page-title-updated', (_, title) => {
      tab.title = title;
      this.broadcastState();
    });

    wc.on('did-navigate', (_, url) => {
      tab.url = url;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.broadcastState();
    });

    wc.on('dom-ready', async () => {
      await CdpStealthBridge.applyToWebContents(wc);
    });

    wc.loadURL(initialUrl).catch(() => {});

    if (!this.activeTabId) {
      this.selectTab(id);
    }

    this.broadcastState();
    return tab;
  }

  selectTab(id: string): boolean {
    const entry = this.tabs.get(id);
    if (!entry || !this.window) return false;

    // Remove previous view if attached
    if (this.activeTabId && this.activeTabId !== id) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) {
        try { this.window.contentView.removeChildView(prev.view); } catch { /* Ignore */ }
      }
    }

    this.activeTabId = id;

    if (this.isVisible) {
      try {
        this.window.contentView.addChildView(entry.view);
        entry.view.setBounds(this.currentBounds);
      } catch { /* Window may be closing */ }
    }

    this.broadcastState();
    return true;
  }

  closeTab(id: string): boolean {
    const entry = this.tabs.get(id);
    if (!entry) return false;

    if (this.window && this.activeTabId === id) {
      try { this.window.contentView.removeChildView(entry.view); } catch { /* Ignore */ }
    }

    // Destroy webcontents
    try {
      (entry.view.webContents as any).destroy();
    } catch { /* Already closed */ }

    this.tabs.delete(id);

    if (this.activeTabId === id) {
      const nextId = Array.from(this.tabs.keys())[0] || null;
      if (nextId) {
        this.selectTab(nextId);
      } else {
        this.activeTabId = null;
      }
    }

    this.broadcastState();
    return true;
  }

  setBounds(bounds: ViewBounds): void {
    this.currentBounds = bounds;
    if (this.activeTabId && this.window && this.isVisible) {
      const active = this.tabs.get(this.activeTabId);
      if (active) {
        active.view.setBounds(bounds);
      }
    }
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    if (!this.window || !this.activeTabId) return;

    const active = this.tabs.get(this.activeTabId);
    if (!active) return;

    if (visible) {
      try {
        this.window.contentView.addChildView(active.view);
        active.view.setBounds(this.currentBounds);
      } catch { /* Ignore */ }
    } else {
      try {
        this.window.contentView.removeChildView(active.view);
      } catch { /* Ignore */ }
    }
  }

  navigate(url: string, id?: string): boolean {
    const targetId = id || this.activeTabId;
    if (!targetId) return false;
    const entry = this.tabs.get(targetId);
    if (!entry) return false;

    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl) && !/^about:/i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    entry.view.webContents.loadURL(targetUrl).catch(() => {});
    return true;
  }

  goBack(id?: string): boolean {
    const targetId = id || this.activeTabId;
    if (!targetId) return false;
    const entry = this.tabs.get(targetId);
    if (!entry || !entry.view.webContents.canGoBack()) return false;
    entry.view.webContents.goBack();
    return true;
  }

  goForward(id?: string): boolean {
    const targetId = id || this.activeTabId;
    if (!targetId) return false;
    const entry = this.tabs.get(targetId);
    if (!entry || !entry.view.webContents.canGoForward()) return false;
    entry.view.webContents.goForward();
    return true;
  }

  reload(id?: string): boolean {
    const targetId = id || this.activeTabId;
    if (!targetId) return false;
    const entry = this.tabs.get(targetId);
    if (!entry) return false;
    entry.view.webContents.reload();
    return true;
  }

  setAgentActive(id: string, active: boolean): void {
    const entry = this.tabs.get(id);
    if (entry) {
      entry.tab.isAgentActive = active;
      this.broadcastState();
    }
  }

  getActiveWebContents() {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId)?.view.webContents || null;
  }

  getTabs(): EmbeddedTab[] {
    return Array.from(this.tabs.values()).map(e => ({ ...e.tab }));
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  private broadcastState(): void {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      this.window.webContents.send('browser:tabs-updated', {
        tabs: this.getTabs(),
        activeTabId: this.activeTabId,
      });
    } catch { /* Ignore */ }
  }
}

export const embeddedBrowserManager = new EmbeddedBrowserManager();
