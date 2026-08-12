import { resolvePythonCommand } from "../runtime_config.ts";

if (import.meta.main) {
  const command = new Deno.Command(await resolvePythonCommand(), {
    args: ["-m", "rowcall", ...Deno.args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  try {
    const status = await command.spawn().status;
    Deno.exit(status.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to run Python Rowcall CLI: ${message}`);
    Deno.exit(2);
  }
}
