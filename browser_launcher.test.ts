import { assertEquals } from "@std/assert";
import { browserCommand } from "./browser_launcher.ts";

Deno.test("browser launching passes authenticated URLs as data on every platform", () => {
  const url = "http://127.0.0.1:8000/?token=a&other=';$test";
  assertEquals(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assertEquals(browserCommand(url, "linux"), {
    command: "xdg-open",
    args: [url],
  });
  const windows = browserCommand(url, "windows");
  assertEquals(windows.command, "powershell.exe");
  assertEquals(windows.env, { ROWCALL_BROWSER_URL: url });
  assertEquals(windows.args.some((arg) => arg.includes(url)), false);
});
