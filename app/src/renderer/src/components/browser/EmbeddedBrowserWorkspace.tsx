import React, { useRef, useEffect, useState } from 'react';
import { BrowserTabBar, TabItem } from './BrowserTabBar';
import { BrowserOmnibox } from './BrowserOmnibox';
import { AgentActionOverlay, OverlayElement } from './AgentActionOverlay';
import { ActionApprovalModal, ActionApprovalRequest } from './ActionApprovalModal';

export function EmbeddedBrowserWorkspace({
  tabs = [],
  activeTabId = null,
  elements = [],
  activeTargetRef = null,
  approvalRequest = null,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onTakeover,
  onApproveAction,
  onRejectAction,
}: {
  tabs: TabItem[];
  activeTabId: string | null;
  elements?: OverlayElement[];
  activeTargetRef?: string | null;
  approvalRequest?: ActionApprovalRequest | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onTakeover?: () => void;
  onApproveAction: (id: string) => void;
  onRejectAction: (id: string) => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  // Report bounds to Electron main process so native WebContentsView matches this container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const reportBounds = () => {
      const rect = el.getBoundingClientRect();
      if ((window as any).bimax?.embeddedBrowser?.setBounds) {
        (window as any).bimax.embeddedBrowser.setBounds({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    };

    reportBounds();
    const observer = new ResizeObserver(reportBounds);
    observer.observe(el);
    window.addEventListener('resize', reportBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
    };
  }, []);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas border-l border-line/80">
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
      />

      <BrowserOmnibox
        currentUrl={activeTab?.url || ''}
        canGoBack={activeTab?.canGoBack}
        canGoForward={activeTab?.canGoForward}
        isLoading={activeTab?.isLoading}
        isAgentActive={activeTab?.isAgentActive}
        onNavigate={onNavigate}
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
        onTakeover={onTakeover}
      />

      {/* WebContentsView Mount Container */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 bg-canvas overflow-hidden"
      >
        <AgentActionOverlay
          elements={elements}
          activeTargetRef={activeTargetRef}
          visible={!!activeTab?.isAgentActive}
        />
      </div>

      <ActionApprovalModal
        request={approvalRequest}
        onApprove={onApproveAction}
        onReject={onRejectAction}
      />
    </div>
  );
}
