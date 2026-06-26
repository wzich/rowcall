export function hasExplicitRunInputs(inputs: unknown): boolean {
  if (inputs === undefined || inputs === null) {
    return false;
  }
  if (!isPlainRecord(inputs)) {
    return true;
  }
  return Object.keys(inputs).length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
