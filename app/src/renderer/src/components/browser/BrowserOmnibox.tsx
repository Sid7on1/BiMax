import React, { useState, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Lock, ShieldAlert, Bot, HandMetal } from 'lucide-react';
import { cn } from '../../lib/cn';

export function BrowserOmnibox({
  currentUrl,
  canGoBack,
  canGoForward,
  isLoading,
  isAgentActive,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onTakeover,
}: {
  currentUrl: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  isAgentActive?: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onTakeover?: () => void;
}): React.ReactElement {
  const [inputUrl, setInputUrl] = useState(currentUrl);

  useEffect(() => {
    setInputUrl(currentUrl);
  }, [currentUrl]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputUrl.trim()) {
      onNavigate(inputUrl.trim());
    }
  };

  const isSecure = currentUrl.startsWith('https://') || currentUrl.startsWith('http://localhost');

  return (
    <div className="flex h-10 items-center gap-2 border-b border-line/60 bg-panel px-3 select-none">
      <div className="flex items-center gap-1 text-dim">
        <button
          type="button"
          onClick={onBack}
          disabled={!canGoBack}
          className="p-1 rounded hover:bg-canvas disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!canGoForward}
          className="p-1 rounded hover:bg-canvas disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={onReload}
          className="p-1 rounded hover:bg-canvas transition-colors"
          title="Reload"
        >
          <RotateCw size={13} className={cn(isLoading && 'animate-spin text-amber')} />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-1 items-center gap-1.5 rounded bg-canvas border border-line/70 px-2.5 py-1 text-[12px] shadow-inner focus-within:border-line focus-within:ring-1 focus-within:ring-line">
        {isSecure ? (
          <Lock size={12} className="shrink-0 text-moss" />
        ) : (
          <ShieldAlert size={12} className="shrink-0 text-amber" />
        )}
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="Search or enter URL (e.g. localhost:3000, github.com)"
          className="flex-1 bg-transparent text-ink placeholder:text-faint focus:outline-none font-mono text-[11px]"
        />
      </form>

      {isAgentActive ? (
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 rounded bg-moss/10 text-moss border border-moss/20 px-2 py-0.5 text-[10.5px] font-medium animate-pulse">
            <Bot size={12} />
            <span>Agent Driving</span>
          </span>
          {onTakeover && (
            <button
              type="button"
              onClick={onTakeover}
              className="flex items-center gap-1 rounded bg-amber/15 text-amber border border-amber/30 px-2 py-0.5 text-[10.5px] font-medium hover:bg-amber/25 transition-colors"
              title="Pause agent and take over control (⌘T)"
            >
              <HandMetal size={12} />
              <span>Takeover</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
