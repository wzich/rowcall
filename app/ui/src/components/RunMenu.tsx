import { useDismissibleLayer } from "./DismissibleDetails.tsx";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

export function ActionMenu(
  {
    disabled,
    onAction,
    label = "Run options",
    actionLabel = "Run with trace",
    chevron = false,
  }: {
    disabled: boolean;
    onAction: () => void;
    label?: string;
    actionLabel?: string;
    chevron?: boolean;
  },
) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismissibleLayer(root, open, () => setOpen(false));
  return (
    <div
      ref={root}
      className="relative"
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        className="h-8 w-7 rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
        onClick={() => setOpen(!open)}
      >
        {chevron
          ? <ChevronDown aria-hidden="true" className="mx-auto h-3.5 w-3.5" />
          : "···"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-40 rounded border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            disabled={disabled}
            className="w-full rounded px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => {
              setOpen(false);
              onAction();
            }}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export function RunMenu({ disabled, onTrace, chevron = false }: {
  disabled: boolean;
  onTrace: () => void;
  chevron?: boolean;
}) {
  return (
    <ActionMenu
      disabled={disabled}
      onAction={onTrace}
      chevron={chevron}
    />
  );
}
