export type PythonSyntaxLocation = {
  line: number;
  column: number;
};

export function pythonSyntaxLocationFromOffset(
  code: string,
  errorOffset: number,
): PythonSyntaxLocation {
  const beforeError = code.slice(0, errorOffset);
  const lines = beforeError.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}
