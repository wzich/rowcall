import { resolvePythonCommand } from "../runtime_config.ts";

const status = await new Deno.Command(await resolvePythonCommand(), {
  args: ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
Deno.exit(status.code);
