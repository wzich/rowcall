const releaseDownloadBaseUrl = Deno.env.get("NODEBOOK_RELEASE_DOWNLOAD_BASE") ??
  "https://releases.nodebook.rodeo";
const pagesProjectName = "nodebook-rodeo";
const r2BucketName = Deno.env.get("NODEBOOK_R2_BUCKET") ??
  "nodebook-rodeo-releases";

const releaseDir = "dist/release";
const siteSourceDir = "site";
const siteDistDir = "dist/site";
const r2DistDir = "dist/r2";

const compileIncludes = [
  "VERSION",
  "pyproject.toml",
  "requirements-alpha.txt",
  "nodebook",
  "app/ui/dist",
];

const releaseAssets = [
  {
    key: "darwin-arm64",
    target: "aarch64-apple-darwin",
    fileName: "nodebook-darwin-arm64",
  },
  {
    key: "darwin-x64",
    target: "x86_64-apple-darwin",
    fileName: "nodebook-darwin-x64",
  },
];

type ManifestDownload = {
  url: string;
  sha256: string;
};

type ReleaseManifest = {
  version: string;
  downloads: Record<string, ManifestDownload>;
};

async function main() {
  const command = Deno.args[0] ?? "help";
  switch (command) {
    case "build":
      await buildReleaseBinaries();
      break;
    case "site":
      await assembleReleaseSite();
      break;
    case "deploy":
      await deployReleaseAssets();
      await deployReleaseSite();
      break;
    case "deploy-assets":
      await deployReleaseAssets();
      break;
    case "deploy-site":
      await deployReleaseSite();
      break;
    case "release":
      await buildReleaseBinaries();
      await assembleReleaseSite();
      await deployReleaseAssets();
      await deployReleaseSite();
      break;
    default:
      printHelp();
      Deno.exit(command === "help" ? 0 : 1);
  }
}

function printHelp() {
  console.info(`Usage:
  deno task release:build   Build macOS release binaries
  deno task release:site    Assemble dist/site and dist/r2
  deno task release:deploy  Upload dist/r2 to R2 and dist/site to Pages
  deno task release         Build, assemble, and deploy`);
}

async function buildReleaseBinaries() {
  await run("deno", ["task", "ui:build"]);
  await emptyDir(releaseDir);

  for (const asset of releaseAssets) {
    const outputPath = `${releaseDir}/${asset.fileName}`;
    const args = [
      "compile",
      "--target",
      asset.target,
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-run",
      "--allow-env",
      ...compileIncludes.flatMap((include) => ["--include", include]),
      "--output",
      outputPath,
      "beta_launcher.ts",
    ];
    await run("deno", args);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(outputPath, 0o755);
    }
  }
}

async function assembleReleaseSite() {
  const version = await readVersion();
  const versionSegment = `v${version}`;
  const downloads: Record<string, ManifestDownload> = {};

  await assertReleaseBinariesExist();
  await emptyDir(siteDistDir);
  await emptyDir(r2DistDir);
  await copyDir(siteSourceDir, siteDistDir);
  await Deno.copyFile("packaging/install.sh", `${siteDistDir}/install.sh`);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(`${siteDistDir}/install.sh`, 0o755);
  }

  for (const directory of ["latest", versionSegment]) {
    await Deno.mkdir(`${r2DistDir}/${directory}`, { recursive: true });
  }

  for (const asset of releaseAssets) {
    const sourcePath = `${releaseDir}/${asset.fileName}`;
    const hash = await sha256Hex(sourcePath);

    for (const directory of ["latest", versionSegment]) {
      const destinationPath = `${r2DistDir}/${directory}/${asset.fileName}`;
      await Deno.copyFile(sourcePath, destinationPath);
      if (Deno.build.os !== "windows") {
        await Deno.chmod(destinationPath, 0o755);
      }
      await writeChecksumSidecar(destinationPath, asset.fileName, hash);
    }

    downloads[asset.key] = {
      url: `${releaseDownloadBaseUrl}/${versionSegment}/${asset.fileName}`,
      sha256: hash,
    };
  }

  const manifest: ReleaseManifest = { version, downloads };
  await Deno.writeTextFile(
    `${siteDistDir}/latest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.info(
    `Assembled ${siteDistDir} and ${r2DistDir} for Nodebook ${version}`,
  );
}

async function deployReleaseAssets() {
  await assertPathExists(`${r2DistDir}/latest/nodebook-darwin-arm64`);
  await assertPathExists(`${r2DistDir}/latest/nodebook-darwin-x64`);

  for (const file of await listFiles(r2DistDir)) {
    const key = file.slice(`${r2DistDir}/`.length);
    const cacheControl = key.startsWith("latest/")
      ? "public, max-age=60"
      : "public, max-age=31536000, immutable";
    const contentType = key.endsWith(".sha256")
      ? "text/plain; charset=utf-8"
      : "application/octet-stream";

    await run("wrangler", [
      "r2",
      "object",
      "put",
      `${r2BucketName}/${key}`,
      "--remote",
      "--file",
      file,
      "--content-type",
      contentType,
      "--cache-control",
      cacheControl,
    ]);
  }
}

async function deployReleaseSite() {
  await assertPathExists(`${siteDistDir}/index.html`);
  await assertPathExists(`${siteDistDir}/install.sh`);
  await assertPathExists(`${siteDistDir}/latest.json`);

  await run("wrangler", [
    "pages",
    "deploy",
    siteDistDir,
    "--project-name",
    pagesProjectName,
    "--branch",
    "main",
  ]);
}

async function assertReleaseBinariesExist() {
  for (const asset of releaseAssets) {
    await assertPathExists(`${releaseDir}/${asset.fileName}`);
  }
}

async function assertPathExists(path: string) {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing required path: ${path}`);
    }
    throw error;
  }
}

async function readVersion(): Promise<string> {
  return (await Deno.readTextFile("VERSION")).trim();
}

async function writeChecksumSidecar(
  binaryPath: string,
  fileName: string,
  hash: string,
) {
  await Deno.writeTextFile(`${binaryPath}.sha256`, `${hash}  ${fileName}\n`);
}

async function sha256Hex(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function emptyDir(path: string) {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(path, { recursive: true });
}

async function copyDir(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = `${source}/${entry.name}`;
    const destinationPath = `${destination}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...await listFiles(path));
    } else if (entry.isFile) {
      files.push(path);
    }
  }
  return files.sort();
}

async function run(command: string, args: string[]) {
  console.info(`$ ${command} ${args.join(" ")}`);
  const status = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`${command} ${args.join(" ")} exited with ${status.code}`);
  }
}

if (import.meta.main) {
  await main();
}
