type DroppedEntry = {
  isDirectory: boolean;
};

export type DirectoryAwareDropItem = {
  kind: string;
  getAsEntry?: () => DroppedEntry | null;
  webkitGetAsEntry?: () => DroppedEntry | null;
};

export function containsDroppedDirectory(
  items: ArrayLike<DirectoryAwareDropItem>,
): boolean {
  return Array.from(items).some((item) => {
    if (item.kind !== "file") return false;
    try {
      const entry = item.getAsEntry?.() ?? item.webkitGetAsEntry?.();
      return entry?.isDirectory === true;
    } catch {
      return false;
    }
  });
}
