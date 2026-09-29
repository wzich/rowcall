import { join, resolve } from "node:path";

export const starterPackages = ["polars"];
const packageChoices = [
  ["polars", "Data frames"],
  ["pandas", "Data frames"],
  ["matplotlib", "Charts"],
  ["seaborn", "Statistical charts"],
];

export function openProjectCommand(directory: string): string {
  const quoted = Deno.build.os === "windows"
    ? `'${directory.replaceAll("'", "''")}'`
    : `'${directory.replaceAll("'", "'\"'\"'")}'`;
  return `rowcall ${quoted}`;
}

export function packageName(requirement: string): string {
  return requirement.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]
    .toLowerCase().replace(/[-_.]+/g, "-") ?? "";
}

export function parseAdditionalPackages(input: string): string[] {
  if (!input.trim()) return [];
  const requirements: string[] = [];
  for (const part of input.split(/,(?![^\[]*\])/)) {
    const value = part.trim();
    if (/^[<>=!~]/.test(value) && requirements.length) {
      requirements[requirements.length - 1] += `,${value}`;
    } else requirements.push(value);
  }
  const requirementPattern =
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?(?:\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|!=|~=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?$/;
  for (const requirement of requirements) {
    if (!requirementPattern.test(requirement)) {
      throw new Error(
        `Invalid package: ${
          requirement || "(empty)"
        }. Use names or version constraints, e.g. duckdb>=1.2, scipy.`,
      );
    }
  }
  return requirements;
}

export function mergePackages(selected: string[], extra: string[]): string[] {
  const packages = new Map<string, string>();
  for (const requirement of [...selected, ...extra]) {
    packages.set(packageName(requirement), requirement);
  }
  return [...packages.values()];
}

export interface WizardIO {
  ask(message: string, defaultValue?: string): string | null;
  selectPackages(): Promise<string[] | null>;
  write(message: string): void;
}

export async function collectProjectSetup(
  io: WizardIO,
  cwd = Deno.cwd(),
): Promise<{ directory: string; packages: string[] } | null> {
  io.write("Create a new Rowcall project");
  io.write("To open an existing project, use rowcall <path>.");
  let directory: string;
  while (true) {
    const name = io.ask("Project name:");
    if (name === null) return null;
    if (
      !name.trim() || /[/\\]/.test(name) || Array.from(name).some((char) =>
        char.charCodeAt(0) < 32
      ) || name.trim() === "." ||
      name.trim() === ".."
    ) {
      io.write("Enter a project name, such as customer-analysis.");
      continue;
    }
    const location = io.ask("Location:", join(cwd, name.trim()));
    if (location === null) return null;
    const expanded = location.startsWith("~/") || location.startsWith("~\\")
      ? join(
        Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? cwd,
        location.slice(2),
      )
      : location;
    directory = resolve(cwd, expanded || join(cwd, name.trim()));
    try {
      await Deno.lstat(directory);
      io.write(
        `That location already exists. Choose a new folder. To open a project there: ${
          openProjectCommand(directory)
        }`,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) break;
      throw error;
    }
  }
  const selected = await io.selectPackages();
  if (selected === null) return null;
  let packages: string[];
  while (true) {
    const extra = io.ask(
      "Additional packages (optional, comma-separated; e.g. duckdb>=1.2, scipy):",
    );
    if (extra === null) return null;
    try {
      packages = mergePackages(selected, parseAdditionalPackages(extra));
      break;
    } catch (error) {
      io.write((error as Error).message);
    }
  }
  io.write(
    `\nCreate ${directory}\nSet up a Python environment in this project\nInstall: ${
      packages.join(", ") || "no additional packages"
    }\nOpen Rowcall in your browser`,
  );
  while (true) {
    const answer = io.ask("Continue? [Y/n]");
    if (answer === null || /^(n|no)$/i.test(answer.trim())) return null;
    if (!answer.trim() || /^(y|yes)$/i.test(answer.trim())) {
      return { directory, packages };
    }
    io.write("Enter y to create the project or n to cancel.");
  }
}

async function selectPackages(): Promise<string[] | null> {
  const selected = new Set(starterPackages);
  let index = 0;
  const write = (text: string) =>
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  console.info(
    "Choose packages — these are installed only in this project's environment.",
  );
  console.info("↑/↓ to move · Space to select · Enter to continue");
  const render = () => {
    for (let i = 0; i < packageChoices.length; i++) {
      const [name, description] = packageChoices[i];
      write(
        `\x1b[2K${i === index ? ">" : " "} [${
          selected.has(name) ? "x" : " "
        }] ${name.padEnd(12)} ${description}\r\n`,
      );
    }
  };
  Deno.stdin.setRaw(true);
  write("\x1b[?25l");
  try {
    render();
    const buffer = new Uint8Array(64);
    let escape = "";
    while (true) {
      const count = await Deno.stdin.read(buffer);
      if (count === null) return null;
      for (const key of new TextDecoder().decode(buffer.subarray(0, count))) {
        if (key === "\x03" || key === "\x04") return null;
        if (key === "\r" || key === "\n") {
          return packageChoices.map(([name]) => name).filter((name) =>
            selected.has(name)
          );
        }
        if (key === "\x1b") {
          escape = key;
          continue;
        }
        if (escape) {
          escape += key;
          if (escape === "\x1b[") continue;
          if (escape === "\x1b[A") {
            index = (index + packageChoices.length - 1) % packageChoices.length;
          }
          if (escape === "\x1b[B") index = (index + 1) % packageChoices.length;
          escape = "";
        } else if (key === " ") {
          const name = packageChoices[index][0];
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
        } else continue;
        write(`\x1b[${packageChoices.length}A`);
        render();
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
    write("\x1b[?25h");
  }
}

export const terminalWizardIO: WizardIO = {
  ask: (message, defaultValue) =>
    prompt(
      defaultValue ? `${message} [${defaultValue}]` : message,
      defaultValue,
    ),
  selectPackages,
  write: (message) => console.info(message),
};

export function starterSource(packages: string[]): string {
  const names = new Set(packages.map(packageName));
  const library = names.has("polars")
    ? "polars"
    : names.has("pandas")
    ? "pandas"
    : null;
  const imports = library
    ? `import ${library} as ${library === "polars" ? "pl" : "pd"}\n`
    : "";
  const body = library
    ? `    # Replace this sample with code that loads your own data.\n    df = ${
      library === "polars" ? "pl" : "pd"
    }.DataFrame({"item": ["A", "B", "C"], "value": [10, 20, 15]})\n    # Use display() to visualize DataFrames or charts.\n    display(df)`
    : `    # Replace this sample with your own Python exploration.\n    message = "Welcome to Rowcall"\n    # Use display() to visualize DataFrames or charts, or show simple values.\n    display(message)`;
  return `${imports}from rowcall import node\n\n\n@node(id="n_start", outputs=[])\ndef start():\n${body}\n    return {}\n`;
}
