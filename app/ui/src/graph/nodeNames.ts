const invalidIdentifierCharacters = /[^A-Za-z0-9_]+/g;
const repeatedUnderscores = /_+/g;
const leadingInvalidCharacters = /^[^A-Za-z_]+/;

export function prettifyFunctionName(functionName: string | undefined): string {
  const trimmed = functionName?.trim();
  if (!trimmed) {
    return "Untitled step";
  }

  const words = trimmed
    .replace(/^_+|_+$/g, "")
    .split(/_+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return trimmed;
  }

  const label = words.join(" ");
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

export function functionNameFromDisplayName(
  displayName: string,
): string | null {
  const normalized = displayName
    .trim()
    .replace(invalidIdentifierCharacters, "_")
    .replace(repeatedUnderscores, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  const identifier = normalized.replace(leadingInvalidCharacters, "");
  if (identifier.length === 0) {
    return null;
  }

  return /^[0-9]/.test(identifier) ? `step_${identifier}` : identifier;
}

export function isValidPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !pythonKeywords.has(value);
}

const pythonKeywords = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
