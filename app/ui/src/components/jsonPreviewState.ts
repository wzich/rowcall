export type JsonPreviewMode = "tree" | "raw";

export const jsonPreviewModeStorageKey = "rowcall:json-preview-mode";

type ModeStorage = Pick<Storage, "getItem" | "setItem">;
type ClipboardWriter = Pick<Clipboard, "writeText">;

function getSessionModeStorage(): ModeStorage | undefined {
  try {
    return typeof globalThis.sessionStorage === "undefined"
      ? undefined
      : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function getClipboardWriter(): ClipboardWriter | undefined {
  try {
    return typeof globalThis.navigator === "undefined"
      ? undefined
      : globalThis.navigator.clipboard;
  } catch {
    return undefined;
  }
}

export function readJsonPreviewMode(
  storage: ModeStorage | undefined = getSessionModeStorage(),
): JsonPreviewMode {
  try {
    return storage?.getItem(jsonPreviewModeStorageKey) === "raw"
      ? "raw"
      : "tree";
  } catch {
    return "tree";
  }
}

export function persistJsonPreviewMode(
  mode: JsonPreviewMode,
  storage: ModeStorage | undefined = getSessionModeStorage(),
): void {
  try {
    storage?.setItem(jsonPreviewModeStorageKey, mode);
  } catch {
    // Storage can be unavailable in restricted or private browser contexts.
  }
}

export function isJsonContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

export function formatJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function shouldExpandJsonNode(
  level: number,
  nodeValue: unknown,
  rootValue: Record<string, unknown> | unknown[],
): boolean {
  if (level === 0) {
    return true;
  }
  if (!Array.isArray(rootValue)) {
    return level < 2;
  }

  return level === 1 &&
    isJsonContainer(nodeValue) &&
    rootValue.slice(0, 3).some((item) => item === nodeValue);
}

export async function copyJsonText(
  text: string,
  clipboard: ClipboardWriter | undefined = getClipboardWriter(),
): Promise<void> {
  if (!clipboard) {
    throw new Error("Clipboard access is unavailable");
  }
  await clipboard.writeText(text);
}
