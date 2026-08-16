export type PreviewCollections = {
  outputs: Record<string, unknown>;
  displays: unknown[];
};

export function hasResultPreviews(
  result: PreviewCollections | undefined,
): boolean {
  return Boolean(
    result &&
      (Object.keys(result.outputs).length > 0 ||
        result.displays.length > 0),
  );
}
