import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

/**
 * Terminal panel — xterm.js view over a main-process pty (node-pty). The xterm instance and its
 * DOM element live in module scope, NOT React state: unmounting the panel (tab switch, dock
 * toggle) detaches the element but keeps the buffer and the pty, and remounting reattaches it.
 * One session per project; switching projects kills and respawns the shell in the new cwd.
 */

// Moonlight ANSI map — black, white and stepped silver, never neon (TUI parity).
const THEME = {
  background: '#0d0d0d',
  foreground: '#eeeeec',
  cursor: '#ffffff',
  cursorAccent: '#0d0d0d',
  selectionBackground: 'rgba(255, 255, 255, 0.22)',
  black: '#242424',
  red: '#c8c8c5',
  green: '#d6d6d2',
  yellow: '#b9b9b5',
  blue: '#bfc0c3',
  magenta: '#c9c6cc',
  cyan: '#c5cccb',
  white: '#eeeeec',
  brightBlack: '#777773',
  brightRed: '#dededb',
  brightGreen: '#e7e7e4',
  brightYellow: '#d2d2ce',
  brightBlue: '#d5d6d8',
  brightMagenta: '#dedbe0',
  brightCyan: '#d9dfde',
  brightWhite: '#ffffff',
};

interface Session {
  project: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ptyId: number | null;
  exited: boolean;
  cleanup: () => void;
}

let session: Session | null = null;

function disposeSession(): void {
  if (!session) return;
  session.cleanup();
  if (session.ptyId !== null) window.bimax.pty.kill(session.ptyId);
  session.term.dispose();
  session.el.remove();
  session = null;
}

async function spawnShell(s: Session): Promise<void> {
  s.exited = false;
  s.ptyId = await window.bimax.pty.create(s.term.cols, s.term.rows);
}

function createSession(project: string, onExitChange: () => void): Session {
  const el = document.createElement('div');
  el.style.width = '100%';
  el.style.height = '100%';
  const term = new Terminal({
    theme: THEME,
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    letterSpacing: 0,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const s: Session = { project, term, fit, el, ptyId: null, exited: false, cleanup: () => {} };

  const offData = window.bimax.pty.onData((id, data) => {
    if (id === s.ptyId) term.write(data);
  });
  const offExit = window.bimax.pty.onExit((id, code) => {
    if (id !== s.ptyId) return;
    s.ptyId = null;
    s.exited = true;
    term.write(`\r\n\x1b[38;5;180m[shell exited (${code})]\x1b[0m\r\n`);
    onExitChange();
  });
  const onInput = term.onData((data) => {
    if (s.ptyId !== null) window.bimax.pty.input(s.ptyId, data);
  });
  const onResize = term.onResize(({ cols, rows }) => {
    if (s.ptyId !== null) window.bimax.pty.resize(s.ptyId, cols, rows);
  });
  s.cleanup = () => { offData(); offExit(); onInput.dispose(); onResize.dispose(); };

  return s;
}

export function TerminalPanel({ project, visible }: { project: string; visible: boolean }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !project) return;

    if (session && session.project !== project) disposeSession();
    if (!session) {
      session = createSession(project, () => setExited(true));
      void spawnShell(session).then(() => setExited(false));
    }
    setExited(session.exited);

    host.appendChild(session.el);
    // Fit only while actually laid out — fitting a display:none pane collapses it to 2 cols.
    const ro = new ResizeObserver(() => {
      if (session && session.el.isConnected && session.el.offsetWidth > 0) {
        try { session.fit.fit(); } catch { /* mid-teardown */ }
      }
    });
    ro.observe(host);
    if (visible) {
      try { session.fit.fit(); } catch { /* not laid out yet */ }
      session.term.focus();
    }

    return () => {
      ro.disconnect();
      if (session && session.el.parentElement === host) host.removeChild(session.el);
    };
  }, [project, visible]);

  return (
    <div className="relative h-full min-h-0">
      <div ref={hostRef} // No frame. `border-line` drew a rule around the terminal and `bg-well` is an opaque
        // recess; it is a surface in a glass app, so it takes the same tint as everything else.
        className="h-full min-h-0 overflow-hidden rounded-lg bg-[var(--pane-veil)] p-1.5" />
      {exited && (
        <button
          onClick={() => {
            if (!session) return;
            setExited(false);
            void spawnShell(session);
            session.term.focus();
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-[var(--float-solid)] px-3 py-1.5 text-xs text-ink shadow-[0_6px_20px_rgba(0,0,0,0.4)] hover:bg-hover"
        >
          <RotateCw size={12} className="text-ember" /> Restart shell
        </button>
      )}
    </div>
  );
}
