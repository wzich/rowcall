import { useRef, useState } from "react";
import type { ReactNode } from "react";

export function readPreference(key: string, fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(`rowcall.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(`rowcall.${key}`, value);
  } catch { /* Workspace preferences must never prevent editing. */ }
}

/** A view preference only: never writes to the graph document. */
export function WorkspaceSplit(
  {
    first,
    second,
    vertical = false,
    storageKey,
    initial = 50,
    label,
    focused = false,
  }: {
    first: ReactNode;
    second: ReactNode;
    vertical?: boolean;
    storageKey: string;
    initial?: number;
    label: string;
    focused?: boolean;
  },
) {
  const root = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(() => {
    const value = Number(readPreference(storageKey, String(initial)));
    return Number.isFinite(value) ? Math.max(15, Math.min(85, value)) : initial;
  });
  const update = (value: number) => {
    const next = Math.max(15, Math.min(85, value));
    setPercent(next);
    savePreference(storageKey, String(next));
  };
  return (
    <div
      ref={root}
      className={`workspace-split ${vertical ? "vertical" : "horizontal"}`}
    >
      <div
        className="split-pane"
        style={{
          display: focused ? "none" : undefined,
          flex: `0 0 ${percent}%`,
        }}
      >
        {first}
      </div>
      {!focused && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={label}
          aria-orientation={vertical ? "horizontal" : "vertical"}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(percent)}
          className="split-handle"
          onKeyDown={(event) => {
            const backward = vertical ? "ArrowUp" : "ArrowLeft";
            const forward = vertical ? "ArrowDown" : "ArrowRight";
            if (event.key === backward || event.key === forward) {
              event.preventDefault();
              update(percent + (event.key === backward ? -2 : 2));
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (
              !event.currentTarget.hasPointerCapture(event.pointerId)
            ) return;
            const bounds = root.current?.getBoundingClientRect();
            if (bounds) {
              update(
                100 * (vertical
                  ? (event.clientY - bounds.top) / bounds.height
                  : (event.clientX - bounds.left) / bounds.width),
              );
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event
                .currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        />
      )}
      <div className="split-pane" style={{ flex: "1 1 0" }}>{second}</div>
    </div>
  );
}
