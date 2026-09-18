export function browserCommand(
  url: string,
  os: typeof Deno.build.os = Deno.build.os,
): { command: string; args: string[]; env?: Record<string, string> } {
  if (os === "windows") {
    // Pass the URL as data, never interpolate it into shell source.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath $env:ROWCALL_BROWSER_URL",
      ],
      env: { ROWCALL_BROWSER_URL: url },
    };
  }
  return { command: os === "darwin" ? "open" : "xdg-open", args: [url] };
}

export async function openBrowser(url: string): Promise<void> {
  const { command, ...options } = browserCommand(url);
  try {
    const output = await new Deno.Command(command, {
      ...options,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (output.success) return;
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  } catch (error) {
    console.warn(
      `Could not open browser automatically: ${
        error instanceof Error ? error.message : String(error)
      }. Open ${url} in your browser.`,
    );
  }
}
