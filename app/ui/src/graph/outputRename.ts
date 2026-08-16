export function detectPureOutputRename(
  previousCode: string,
  nextCode: string,
  declaredOutputs: string[],
  previousAssignments: string[],
  nextAssignments: string[],
): { fromOutput: string; toOutput: string } | null {
  const removed = declaredOutputs.filter((output) =>
    previousAssignments.includes(output) && !nextAssignments.includes(output)
  );
  const added = nextAssignments.filter((output) =>
    !previousAssignments.includes(output)
  );
  if (removed.length !== 1 || added.length !== 1) return null;

  const fromOutput = removed[0];
  const toOutput = added[0];
  if (declaredOutputs.includes(toOutput)) return null;
  const placeholder = "__rowcall_renamed_output__";
  const normalizedPrevious = previousCode.replaceAll(
    new RegExp(`\\b${fromOutput}\\b`, "gu"),
    placeholder,
  );
  const normalizedNext = nextCode.replaceAll(
    new RegExp(`\\b${toOutput}\\b`, "gu"),
    placeholder,
  );
  return normalizedPrevious === normalizedNext
    ? { fromOutput, toOutput }
    : null;
}
