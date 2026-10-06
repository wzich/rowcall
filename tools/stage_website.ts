// A website-only deployment must preserve the currently published installer and
// manifest, even when main already contains an unreleased version bump.
export function validatePublishedManifest(value: unknown): void {
  const manifest = value as {
    version?: string;
    downloads?: Record<string, { url: string; sha256: string }>;
  } | null;
  if (!manifest || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
    throw new Error("Invalid published version");
  }
  const platforms = ["darwin-arm64", "darwin-x64"];
  if (manifest.downloads && "windows-x64" in manifest.downloads) {
    platforms.push("windows-x64");
  }
  for (const platform of platforms) {
    const asset = manifest.downloads?.[platform];
    if (
      !asset || asset.url !==
        `https://releases.rowcall.io/v${manifest.version}/rowcall-${platform}${
          platform === "windows-x64" ? ".exe" : ""
        }` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) throw new Error(`Invalid published download: ${platform}`);
  }
}

export async function readPublishedWindowsInstaller(
  manifest: { downloads?: Record<string, unknown> },
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  // Existing Mac-only releases have no Windows installer to preserve yet.
  if (!manifest.downloads || !("windows-x64" in manifest.downloads)) {
    return null;
  }
  const response = await fetcher("https://rowcall.io/install.ps1", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Cannot read published Windows installer");
  const installer = await response.text();
  if (!installer.startsWith("[CmdletBinding()]")) {
    throw new Error("Invalid published Windows installer");
  }
  return installer;
}

async function copyDirectory(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.isDirectory) {
      await copyDirectory(
        `${source}/${entry.name}`,
        `${destination}/${entry.name}`,
      );
    } else if (entry.isFile) {
      await Deno.copyFile(
        `${source}/${entry.name}`,
        `${destination}/${entry.name}`,
      );
    }
  }
}

if (import.meta.main) {
  const manifestResponse = await fetch("https://rowcall.io/latest.json", {
    cache: "no-store",
  });
  const installerResponse = await fetch("https://rowcall.io/install.sh", {
    cache: "no-store",
  });
  if (!manifestResponse.ok || !installerResponse.ok) {
    throw new Error("Cannot read published download metadata");
  }
  const manifest = await manifestResponse.text();
  validatePublishedManifest(JSON.parse(manifest));
  const windowsInstaller = await readPublishedWindowsInstaller(
    JSON.parse(manifest),
  );
  const installer = await installerResponse.text();
  if (!installer.startsWith("#!/bin/sh\n")) {
    throw new Error("Invalid published installer");
  }
  await Deno.remove("dist/website", { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await copyDirectory("site", "dist/website");
  await Deno.writeTextFile("dist/website/latest.json", manifest);
  await Deno.writeTextFile("dist/website/install.sh", installer);
  if (windowsInstaller !== null) {
    await Deno.writeTextFile("dist/website/install.ps1", windowsInstaller);
  }
}
