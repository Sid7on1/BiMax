/**
 * CDP Stealth & Anti-Debugging Bridge.
 *
 * Web applications sometimes use anti-debugging scripts (such as setInterval debugger; loops,
 * Function constructor traps, and dimension-based DevTools detection) to freeze automated inspection.
 *
 * This module configures Chrome DevTools Protocol (CDP) sessions with:
 *   1. Automatic breakpoint deactivation (Debugger.setBreakpointsActive = false).
 *   2. Prototype shielding to neuter Function/eval("debugger") traps.
 *   3. Out-Of-Process Iframes (OOPIF) auto-attachment via Target.setAutoAttach.
 *   4. Automation flag masking (--disable-blink-features=AutomationControlled, navigator.webdriver = undefined).
 */

import type { WebContents } from 'electron';

export const STEALTH_INITIALIZATION_SCRIPT = `(() => {
  try {
    // 1. Neuter navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // 2. Shield against Function("debugger")() and eval("debugger") anti-debugging loops
    const originalFunction = window.Function;
    const patchedFunction = function(...args: any[]) {
      if (args.some(arg => typeof arg === 'string' && /debugger/i.test(arg))) {
        return function() {};
      }
      return originalFunction.apply(this, args);
    };
    patchedFunction.prototype = originalFunction.prototype;
    window.Function = patchedFunction as any;

    const originalEval = window.eval;
    window.eval = function(code: string) {
      if (typeof code === 'string' && /debugger/i.test(code)) {
        return undefined;
      }
      return originalEval.apply(this, [code]);
    };

    // 3. Normalize window dimensions if inspected for DevTools docking differences
    if (window.outerWidth === 0 || window.outerHeight === 0) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight, configurable: true });
    }

    // 4. Chrome runtime mock for automation detection
    if (!(window as any).chrome) {
      (window as any).chrome = { runtime: {} };
    }
  } catch {
    // Stealth is best-effort and must never break valid page scripts
  }
})();`;

export interface CdpStealthConfig {
  disableBreakpoints?: boolean;
  autoAttachFrames?: boolean;
  maskAutomation?: boolean;
}

export class CdpStealthBridge {
  /** Configure a WebContents instance with stealth and anti-debugging protection. */
  static async applyToWebContents(
    webContents: WebContents,
    config: CdpStealthConfig = { disableBreakpoints: true, autoAttachFrames: true, maskAutomation: true },
  ): Promise<void> {
    if (webContents.isDestroyed()) return;

    if (config.maskAutomation) {
      try {
        await webContents.executeJavaScript(STEALTH_INITIALIZATION_SCRIPT);
      } catch { /* Page might be navigating */ }
    }

    // Attach CDP debugger if not already attached
    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3');
      }

      if (config.disableBreakpoints) {
        await webContents.debugger.sendCommand('Debugger.enable').catch(() => {});
        await webContents.debugger.sendCommand('Debugger.setBreakpointsActive', { active: false }).catch(() => {});
        await webContents.debugger.sendCommand('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
      }

      if (config.autoAttachFrames) {
        await webContents.debugger.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => {});
      }
    } catch {
      // Debugger might already be in use or disallowed on internal pages
    }
  }

  /** Configure a Puppeteer CDPSession with stealth and anti-debugging protection. */
  static async applyToCdpSession(session: any): Promise<void> {
    try {
      await session.send('Debugger.enable').catch(() => {});
      await session.send('Debugger.setBreakpointsActive', { active: false }).catch(() => {});
      await session.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
      await session.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
    } catch {
      // Best-effort CDP session initialization
    }
  }
}
