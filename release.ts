const releaseDownloadBaseUrl = Deno.env.get("NODEBOOK_RELEASE_DOWNLOAD_BASE") ??
  "https://releases.nodebook.rodeo";
const pagesProjectName = "nodebook-rodeo";
const r2BucketName = Deno.env.get("NODEBOOK_R2_BUCKET") ??
  "nodebook-rodeo-releases";

const releaseDir = "dist/release";
const siteSourceDir = "site";
const siteDistDir = "dist/site";
const r2DistDir = "dist/r2";
const smokeAttestationSuffix = ".smoke-attestation.json";

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
    nativeArchitecture: "arm64",
  },
  {
    key: "darwin-x64",
    target: "x86_64-apple-darwin",
    fileName: "nodebook-darwin-x64",
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
  schemaVersion: 2;
  asset: string;
  sha256: string;
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  nativeArchitecture: "arm64" | "x64";
  authorization: "github-actions-workflow" | "diagnostic";
  workflowRunId: string | null;
  workflowRunAttempt: string | null;
  workflowName: string | null;
  workflowEvent: string | null;
  workflowJob: string | null;
  workflowRef: string | null;
  workflowRepository: string | null;
  runnerArchitecture: "ARM64" | "X64" | null;
};

export type ValidatedReleaseIdentity = {
  version: string;
  sourceCommit: string;
  workflowRunId: string;
  workflowRunAttempt: string;
  hashes: Record<string, string>;
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
      await assembleReleaseSite();
      await deployReleaseAssets();
      await deployReleaseSite();
      break;
    case "deploy-assets":
      await assembleReleaseSite();
      await deployReleaseAssets();
      break;
    case "deploy-site":
      await assembleReleaseSite();
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
  deno task release:smoke -- <native artifact>
                            Natively run one artifact and attest it
  deno task release:site    Verify both native attestations, then assemble
  deno task release:deploy  Reverify and upload dist/r2 and dist/site`);
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
  const sourceCommit = await requireCleanSourceCommit();
  const versionSegment = `v${version}`;
  const downloads: Record<string, ManifestDownload> = {};

  await validateReleaseArtifacts({
    directory: releaseDir,
    expectedVersion: version,
    expectedSourceCommit: sourceCommit,
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
      await Deno.copyFile(
        smokeAttestationPath(sourcePath),
        smokeAttestationPath(destinationPath),
      );
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
}): Promise<ValidatedReleaseIdentity> {
  let identity: ValidatedReleaseIdentity | undefined;
  const hashes: Record<string, string> = {};

  for (const asset of releaseAssets) {
    const binaryPath = `${options.directory}/${asset.fileName}`;
    const attestationPath = smokeAttestationPath(binaryPath);
    await assertPathExists(binaryPath);
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
    const actualHash = await sha256Hex(binaryPath);

    if (attestation.asset !== asset.fileName) {
      throw new Error(
        `Smoke attestation ${attestationPath} names ${attestation.asset}; expected ${asset.fileName}`,
      );
    }
    if (attestation.nativeArchitecture !== asset.nativeArchitecture) {
      throw new Error(
        `Smoke attestation ${attestationPath} records ${attestation.nativeArchitecture}; expected a native ${asset.nativeArchitecture} smoke`,
      );
    }
    if (attestation.sha256 !== actualHash) {
      throw new Error(
        `Smoke attestation hash does not match ${binaryPath}`,
      );
    }
    if (attestation.version !== options.expectedVersion) {
      throw new Error(
        `Smoke attestation ${attestationPath} is for version ${attestation.version}; expected ${options.expectedVersion}`,
      );
    }
    if (attestation.sourceDirty) {
      throw new Error(
        `Smoke attestation ${attestationPath} was produced from a dirty source tree and cannot authorize a release`,
      );
    }
    if (attestation.authorization !== "github-actions-workflow") {
      throw new Error(
        `Smoke attestation ${attestationPath} is diagnostic only and cannot authorize a release`,
      );
    }
    const expectedRunnerArchitecture = asset.nativeArchitecture === "arm64"
      ? "ARM64"
      : "X64";
    if (
      attestation.workflowName !== "Invited beta smoke" ||
      attestation.workflowEvent !== "workflow_dispatch" ||
      attestation.workflowJob !== "build-and-smoke" ||
      attestation.workflowRepository !== "wzich/nodebook" ||
      attestation.workflowRef === null ||
      !attestation.workflowRef.startsWith(
        "wzich/nodebook/.github/workflows/invited-beta-smoke.yml@",
      ) ||
      attestation.runnerArchitecture !== expectedRunnerArchitecture ||
      attestation.workflowRunId === null ||
      !/^[1-9][0-9]*$/.test(attestation.workflowRunId) ||
      attestation.workflowRunAttempt === null ||
      !/^[1-9][0-9]*$/.test(attestation.workflowRunAttempt)
    ) {
      throw new Error(
        `Smoke attestation ${attestationPath} does not contain a valid manual GitHub workflow receipt`,
      );
    }
    if (
      options.expectedSourceCommit !== undefined &&
      attestation.sourceCommit !== options.expectedSourceCommit
    ) {
      throw new Error(
        `Smoke attestation ${attestationPath} is for source commit ${attestation.sourceCommit}; current checkout is ${options.expectedSourceCommit}`,
      );
    }

    const candidateIdentity = {
      version: attestation.version,
      sourceCommit: attestation.sourceCommit,
      workflowRunId: attestation.workflowRunId,
      workflowRunAttempt: attestation.workflowRunAttempt,
    };
    if (identity === undefined) {
      identity = { ...candidateIdentity, hashes };
    } else if (
      identity.version !== candidateIdentity.version ||
      identity.sourceCommit !== candidateIdentity.sourceCommit ||
      identity.workflowRunId !== candidateIdentity.workflowRunId ||
      identity.workflowRunAttempt !== candidateIdentity.workflowRunAttempt
    ) {
      throw new Error(
        "Release artifacts do not have authorizing native-smoke attestations from the same workflow run, attempt, source commit, and version",
      );
    }
    hashes[asset.key] = actualHash;
  }

  if (identity === undefined) {
    throw new Error("No release artifacts configured");
  }
  return identity;
}

async function validateAssembledRelease() {
  const version = await readVersion();
  const sourceCommit = await requireCleanSourceCommit();
  const versionSegment = `v${version}`;
  const latestIdentity = await validateReleaseArtifacts({
    directory: `${r2DistDir}/latest`,
    expectedVersion: version,
    expectedSourceCommit: sourceCommit,
  });
  const versionedIdentity = await validateReleaseArtifacts({
    directory: `${r2DistDir}/${versionSegment}`,
    expectedVersion: version,
    expectedSourceCommit: sourceCommit,
  });
  if (
    latestIdentity.version !== versionedIdentity.version ||
    latestIdentity.sourceCommit !== versionedIdentity.sourceCommit ||
    latestIdentity.workflowRunId !== versionedIdentity.workflowRunId ||
    latestIdentity.workflowRunAttempt !==
      versionedIdentity.workflowRunAttempt ||
    releaseAssets.some((asset) =>
      latestIdentity.hashes[asset.key] !== versionedIdentity.hashes[asset.key]
    )
  ) {
    throw new Error(
      "latest and versioned release directories were not assembled from the same attested artifacts",
    );
  }
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
      "Release assembly and deployment require a clean source checkout",
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
    record.schemaVersion !== 2 ||
    typeof record.asset !== "string" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.version !== "string" ||
    typeof record.sourceCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(record.sourceCommit) ||
    typeof record.sourceDirty !== "boolean" ||
    (record.nativeArchitecture !== "arm64" &&
      record.nativeArchitecture !== "x64") ||
    (record.authorization !== "github-actions-workflow" &&
      record.authorization !== "diagnostic") ||
    (record.workflowRunId !== null &&
      typeof record.workflowRunId !== "string") ||
    (record.workflowRunAttempt !== null &&
      typeof record.workflowRunAttempt !== "string") ||
    (record.workflowName !== null && typeof record.workflowName !== "string") ||
    (record.workflowEvent !== null &&
      typeof record.workflowEvent !== "string") ||
    (record.workflowJob !== null && typeof record.workflowJob !== "string") ||
    (record.workflowRef !== null && typeof record.workflowRef !== "string") ||
    (record.workflowRepository !== null &&
      typeof record.workflowRepository !== "string") ||
    (record.runnerArchitecture !== null &&
      record.runnerArchitecture !== "ARM64" &&
      record.runnerArchitecture !== "X64")
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
