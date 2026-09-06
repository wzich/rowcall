import { type ComponentProps, type RefObject, useEffect, useRef } from "react";

export function useDismissibleLayer(
  root: RefObject<HTMLElement | null>,
  open: boolean | (() => boolean),
  dismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const pointerDown = (event: PointerEvent) => {
      if (
        (typeof open === "function" ? open() : open) &&
        !root.current?.contains(event.target as Node)
      ) dismiss();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || !(typeof open === "function" ? open() : open)
      ) return;
      event.preventDefault();
      dismiss();
      root.current?.querySelector<HTMLElement>("summary, button")?.focus();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown);
    };
  }, [root, open, dismiss]);
}

export function DismissibleDetails(props: ComponentProps<"details">) {
  const root = useRef<HTMLDetailsElement>(null);
  useDismissibleLayer(root, () => root.current?.open ?? false, () => {
    if (root.current) root.current.open = false;
  });
  return <details {...props} ref={root} />;
}
