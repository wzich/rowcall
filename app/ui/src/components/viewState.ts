export type PreviewCollections = {
  outputs: Record<string, unknown>;
  views: Record<string, unknown>;
};

export function hasResultPreviews(
  result: PreviewCollections | undefined,
): boolean {
  return Boolean(
    result &&
      (Object.keys(result.outputs).length > 0 ||
        Object.keys(result.views).length > 0),
  );
}

export function toggleOrderedName(
  names: string[],
  name: string,
  maximum: number,
): string[] {
  if (names.includes(name)) {
    return names.filter((existing) => existing !== name);
  }
  if (names.length >= maximum) {
    return names;
  }
  return [...names, name];
}
