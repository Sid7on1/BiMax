import React from 'react';

export interface OverlayElement {
  index: number;
  ref: string;
  role: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  isTargeted?: boolean;
}

export function AgentActionOverlay({
  elements = [],
  activeTargetRef,
  visible = true,
}: {
  elements?: OverlayElement[];
  activeTargetRef?: string | null;
  visible?: boolean;
}): React.ReactElement | null {
  if (!visible || elements.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden select-none">
      {elements.map((el) => {
        const isTargeted = el.ref === activeTargetRef || el.isTargeted;
        return (
          <div
            key={el.ref || el.index}
            style={{
              left: `${el.rect.x}px`,
              top: `${el.rect.y}px`,
              width: `${Math.max(el.rect.width, 16)}px`,
              height: `${Math.max(el.rect.height, 16)}px`,
            }}
            className={`absolute border transition-all duration-150 rounded ${
              isTargeted
                ? 'border-amber bg-amber/20 ring-2 ring-amber/50 animate-pulse'
                : 'border-moss/60 bg-moss/5 hover:border-moss hover:bg-moss/10'
            }`}
          >
            <span
              className={`absolute -top-3 -left-1 flex h-4 min-w-4 items-center justify-center rounded px-1 text-[9px] font-mono font-bold shadow-sm ${
                isTargeted
                  ? 'bg-amber text-canvas'
                  : 'bg-moss text-canvas'
              }`}
            >
              {el.index + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
