const releaseDownloadBaseUrl = Deno.env.get("ROWCALL_RELEASE_DOWNLOAD_BASE") ??
  "https://releases.rowcall.io";
const pagesProjectName = "rowcall-io";
const r2BucketName = Deno.env.get("ROWCALL_R2_BUCKET") ??
  "rowcall-io-releases";

const releaseDir = "dist/release";
const siteSourceDir = "site";
const siteDistDir = "dist/site";
const r2DistDir = "dist/r2";
const smokeAttestationSuffix = ".smoke-attestation.json";

const compileIncludes = [
  "VERSION",
  "pyproject.toml",
  "requirements-alpha.txt",
  "rowcall",
  "app/ui/dist",
];

const releaseAssets = [
  {
    key: "darwin-arm64",
    target: "aarch64-apple-darwin",
    fileName: "rowcall-darwin-arm64",
    nativeArchitecture: "arm64",
  },
  {
    key: "darwin-x64",
    target: "x86_64-apple-darwin",
    fileName: "rowcall-darwin-x64",
    nativeArchitecture: "x64",
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

type ReleaseSmokeAttestation = {
  schemaVersion: 1;
  asset: string;
  sha256: string;
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  nativeArchitecture: "arm64" | "x64";
};

export type ValidatedReleaseIdentity = {
  version: string;
  sourceCommit: string;
  nativeSmokedAsset: string;
  hashes: Record<string, string>;
};

async function main() {
  const command = Deno.args[0] ?? "help";
  switch (command) {
    case "prepare":
      await prepareRelease();
      break;
    case "publish":
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
  deno task release:prepare  Check, test, build, smoke, and stage a release
  deno task release:publish  Validate and publish the staged release`);
}

async function prepareRelease() {
  await requireCleanSourceCommit();
  await run("deno", ["task", "check"]);
  await run("deno", ["task", "test"]);
  await run("deno", ["task", "test:browser"]);
  await buildReleaseBinaries();
  await run("sh", ["packaging/smoke-installed-release.sh"]);
  await assembleReleaseSite();
}

async function buildReleaseBinaries() {
  await run("deno", ["task", "build"]);
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
      "launcher.ts",
    ];
    await run("deno", args);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(outputPath, 0o755);
    }
  }
}

async function assembleReleaseSite() {
  const version = await readVersion();
  const sourceCommit = await requireCleanSourceCommit();
  const versionSegment = `v${version}`;
  const downloads: Record<string, ManifestDownload> = {};

  await validateReleaseArtifacts({
    directory: releaseDir,
    expectedVersion: version,
    expectedSourceCommit: sourceCommit,
    verifyArchitectures: true,
  });
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
    `Assembled ${siteDistDir} and ${r2DistDir} for Rowcall ${version}`,
  );
}

async function deployReleaseAssets() {
  await validateAssembledRelease();

  for (const file of await listFiles(r2DistDir)) {
    const key = file.slice(`${r2DistDir}/`.length);
    const cacheControl = key.startsWith("latest/")
      ? "public, max-age=60"
      : "public, max-age=31536000, immutable";
    const contentType = key.endsWith(".sha256")
      ? "text/plain; charset=utf-8"
      : key.endsWith(".json")
      ? "application/json; charset=utf-8"
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
  await validateAssembledRelease();
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

export async function validateReleaseArtifacts(options: {
  directory: string;
  expectedVersion: string;
  expectedSourceCommit?: string;
  expectedNativeArchitecture?: "arm64" | "x64";
  verifyArchitectures?: boolean;
}): Promise<ValidatedReleaseIdentity> {
  const hashes: Record<string, string> = {};
  const nativeArchitecture = options.expectedNativeArchitecture ??
    nativeArchitectureForHost();
  const nativeAsset = releaseAssets.find((asset) =>
    asset.nativeArchitecture === nativeArchitecture
  );
  if (nativeAsset === undefined) {
    throw new Error(
      `Unsupported release host architecture: ${Deno.build.arch}`,
    );
  }

  for (const asset of releaseAssets) {
    const binaryPath = `${options.directory}/${asset.fileName}`;
    await assertPathExists(binaryPath);
    if (options.verifyArchitectures) {
      const architectures = (await commandOutput("/usr/bin/lipo", [
        "-archs",
        binaryPath,
      ])).trim();
      const expected = asset.nativeArchitecture === "arm64"
        ? "arm64"
        : "x86_64";
      if (architectures !== expected) {
        throw new Error(
          `${binaryPath} has architecture ${architectures}; expected ${expected}`,
        );
      }
    }
    hashes[asset.key] = await sha256Hex(binaryPath);
  }

  const attestationPath = smokeAttestationPath(
    `${options.directory}/${nativeAsset.fileName}`,
  );
  await assertPathExists(attestationPath);
  let candidate: unknown;
  try {
    candidate = JSON.parse(await Deno.readTextFile(attestationPath));
  } catch (error) {
    throw new Error(
      `Invalid smoke attestation ${attestationPath}: ${errorMessage(error)}`,
    );
  }
  const attestation = parseSmokeAttestation(candidate, attestationPath);
  if (
    attestation.asset !== nativeAsset.fileName ||
    attestation.nativeArchitecture !== nativeAsset.nativeArchitecture
  ) {
    throw new Error(
      `Smoke attestation ${attestationPath} does not match the native ${nativeAsset.fileName} artifact`,
    );
  }
  if (attestation.sha256 !== hashes[nativeAsset.key]) {
    throw new Error(
      `Smoke attestation hash does not match ${nativeAsset.fileName}`,
    );
  }
  if (attestation.version !== options.expectedVersion) {
    throw new Error(
      `Smoke attestation is for version ${attestation.version}; expected ${options.expectedVersion}`,
    );
  }
  if (attestation.sourceDirty) {
    throw new Error(
      "Smoke attestation was produced from a dirty source tree",
    );
  }
  if (
    options.expectedSourceCommit !== undefined &&
    attestation.sourceCommit !== options.expectedSourceCommit
  ) {
    throw new Error(
      `Smoke attestation is for source commit ${attestation.sourceCommit}; current checkout is ${options.expectedSourceCommit}`,
    );
  }

  return {
    version: attestation.version,
    sourceCommit: attestation.sourceCommit,
    nativeSmokedAsset: nativeAsset.fileName,
    hashes,
  };
}

async function validateAssembledRelease() {
  const version = await readVersion();
  const sourceCommit = await requireCleanSourceCommit();
  const versionSegment = `v${version}`;
  const identity = await validateReleaseArtifacts({
    directory: releaseDir,
    expectedVersion: version,
    expectedSourceCommit: sourceCommit,
    verifyArchitectures: true,
  });

  for (const directory of ["latest", versionSegment]) {
    for (const asset of releaseAssets) {
      const binaryPath = `${r2DistDir}/${directory}/${asset.fileName}`;
      await assertPathExists(binaryPath);
      const hash = await sha256Hex(binaryPath);
      if (hash !== identity.hashes[asset.key]) {
        throw new Error(`${binaryPath} does not match the prepared release`);
      }
      const checksum = await Deno.readTextFile(`${binaryPath}.sha256`);
      if (checksum !== `${hash}  ${asset.fileName}\n`) {
        throw new Error(`Invalid checksum sidecar for ${binaryPath}`);
      }
    }
  }

  await validateStagedSite({ version, identity });
}

async function validateStagedSite(options: {
  version: string;
  identity: ValidatedReleaseIdentity;
}) {
  const sourceFiles = await listFiles(siteSourceDir);
  const expectedRelativeFiles = sourceFiles.map((path) =>
    path.slice(`${siteSourceDir}/`.length)
  );
  expectedRelativeFiles.push("install.sh", "latest.json");
  expectedRelativeFiles.sort();

  const stagedRelativeFiles = (await listFiles(siteDistDir)).map((path) =>
    path.slice(`${siteDistDir}/`.length)
  );
  if (
    JSON.stringify(stagedRelativeFiles) !==
      JSON.stringify(expectedRelativeFiles)
  ) {
    throw new Error(
      `${siteDistDir} does not contain the expected staged site files`,
    );
  }

  for (const sourcePath of sourceFiles) {
    const relativePath = sourcePath.slice(`${siteSourceDir}/`.length);
    await assertFilesMatch(
      sourcePath,
      `${siteDistDir}/${relativePath}`,
    );
  }
  await assertFilesMatch(
    "packaging/install.sh",
    `${siteDistDir}/install.sh`,
  );

  let candidate: unknown;
  const manifestPath = `${siteDistDir}/latest.json`;
  try {
    candidate = JSON.parse(await Deno.readTextFile(manifestPath));
  } catch (error) {
    throw new Error(
      `Invalid release manifest ${manifestPath}: ${errorMessage(error)}`,
    );
  }
  validateReleaseManifest(candidate, options);
}

export function validateReleaseManifest(
  value: unknown,
  options: {
    version: string;
    identity: ValidatedReleaseIdentity;
  },
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid release manifest: expected an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== options.version ||
    typeof record.downloads !== "object" ||
    record.downloads === null ||
    Array.isArray(record.downloads)
  ) {
    throw new Error("Invalid release manifest: malformed version or downloads");
  }

  const downloads = record.downloads as Record<string, unknown>;
  const expectedKeys = releaseAssets.map((asset) => asset.key).sort();
  if (
    JSON.stringify(Object.keys(downloads).sort()) !==
      JSON.stringify(expectedKeys)
  ) {
    throw new Error("Invalid release manifest: unexpected download keys");
  }

  for (const asset of releaseAssets) {
    const download = downloads[asset.key];
    if (
      typeof download !== "object" ||
      download === null ||
      Array.isArray(download)
    ) {
      throw new Error(
        `Invalid release manifest: malformed ${asset.key} download`,
      );
    }
    const fields = download as Record<string, unknown>;
    const expectedSuffix = `/v${options.version}/${asset.fileName}`;
    if (
      typeof fields.url !== "string" ||
      !fields.url.endsWith(expectedSuffix) ||
      fields.sha256 !== options.identity.hashes[asset.key] ||
      JSON.stringify(Object.keys(fields).sort()) !==
        JSON.stringify(["sha256", "url"])
    ) {
      throw new Error(
        `Invalid release manifest: ${asset.key} does not match the prepared release`,
      );
    }
  }
}

async function assertFilesMatch(expectedPath: string, actualPath: string) {
  await assertPathExists(actualPath);
  if (await sha256Hex(expectedPath) !== await sha256Hex(actualPath)) {
    throw new Error(`${actualPath} does not match ${expectedPath}`);
  }
}

function nativeArchitectureForHost(): "arm64" | "x64" {
  if (Deno.build.arch === "aarch64") return "arm64";
  if (Deno.build.arch === "x86_64") return "x64";
  throw new Error(`Unsupported release host architecture: ${Deno.build.arch}`);
}

async function requireCleanSourceCommit(): Promise<string> {
  const sourceCommit = (await commandOutput("git", ["rev-parse", "HEAD"]))
    .trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    throw new Error(
      `Could not determine a valid source commit: ${sourceCommit}`,
    );
  }
  const status = await commandOutput("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status.trim() !== "") {
    throw new Error(
      "Release preparation and publishing require a clean source checkout",
    );
  }
  return sourceCommit;
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const output = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${output.code}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

function smokeAttestationPath(binaryPath: string): string {
  return `${binaryPath}${smokeAttestationSuffix}`;
}

function parseSmokeAttestation(
  value: unknown,
  path: string,
): ReleaseSmokeAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid smoke attestation ${path}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.asset !== "string" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.version !== "string" ||
    typeof record.sourceCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(record.sourceCommit) ||
    typeof record.sourceDirty !== "boolean" ||
    (record.nativeArchitecture !== "arm64" &&
      record.nativeArchitecture !== "x64")
  ) {
    throw new Error(`Invalid smoke attestation ${path}: malformed fields`);
  }
  return record as ReleaseSmokeAttestation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
