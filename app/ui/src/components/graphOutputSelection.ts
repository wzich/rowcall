export function resolveGraphOutputSelection(
  selectedKey: string,
  availableKeys: string[],
): string {
  return availableKeys.includes(selectedKey)
    ? selectedKey
    : availableKeys[0] ?? "";
}
