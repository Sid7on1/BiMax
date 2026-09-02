import React from 'react';
import { Plus, X, Globe, Bot, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  title: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  isAgentActive?: boolean;
}

export function BrowserTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: {
  tabs: TabItem[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-9 items-center gap-1 border-b border-line/70 bg-panel/60 px-2 select-none">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={cn(
                'group flex h-7 max-w-[200px] min-w-[120px] items-center gap-1.5 rounded px-2 text-[11.5px] cursor-pointer transition-colors',
                isActive
                  ? 'bg-canvas text-ink shadow-sm border border-line/80 font-medium'
                  : 'text-dim hover:bg-canvas/50 hover:text-ink'
              )}
            >
              {tab.isLoading ? (
                <Loader2 size={12} className="shrink-0 animate-spin text-amber" />
              ) : tab.isAgentActive ? (
                <span className="flex shrink-0 items-center gap-0.5 text-moss" title="Driven by Bimax Agent">
                  <Bot size={12} />
                </span>
              ) : (
                <Globe size={12} className="shrink-0 text-faint group-hover:text-dim" />
              )}

              <span className="truncate flex-1">{tab.title || tab.url || 'New Tab'}</span>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-line/60 rounded text-faint hover:text-ink transition-opacity"
                title="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onNewTab}
        className="flex size-6 items-center justify-center rounded text-dim hover:bg-canvas hover:text-ink transition-colors"
        title="Open new tab (⌘T)"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
