import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") {
  throw new Error("Windows release smoke requires native Windows x64");
}
const asset = "rowcall-windows-x64.exe";
const artifact = resolve("dist/windows-release", asset);
const installer = resolve("packaging/install.ps1");
const version = (await Deno.readTextFile("VERSION")).trim();
const commit = await run("git", ["rev-parse", "HEAD"]);
const sourceStatus = await run("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=normal",
]);
const hash = await sha256(artifact);
await Deno.writeTextFile(`${artifact}.sha256`, `${hash}  ${asset}\n`);
const root = await Deno.makeTempDir({ prefix: "rowcall Windows ü " });
const home = `${root}/home`;
const outside = `${root}/outside checkout`;
const installDir = `${root}/installed bin`;
const installed = `${installDir}/rowcall.exe`;
const cleanEnvironment = {
  HOME: home,
  USERPROFILE: home,
  PYTHONPATH: "",
  VIRTUAL_ENV: "",
  CONDA_PREFIX: "",
};
try {
  await Deno.mkdir(home);
  await Deno.mkdir(outside);
  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installer,
    "-DownloadUrl",
    pathToFileURL(artifact).href,
    "-InstallDir",
    installDir,
  ], { env: cleanEnvironment, cwd: outside });
  if (await sha256(installed) !== hash) {
    throw new Error("Installer changed the binary");
  }
  const invoke = (args: string[]) =>
    run(installed, args, { env: cleanEnvironment, cwd: outside });
  if (await invoke(["--version"]) !== version) {
    throw new Error("Version mismatch");
  }
  const project = `${root}/project with spaces ü`;
  await invoke(["new", project]);
  // Exercise fresh project environment creation and dependency setup.
  const result = JSON.parse(
    await invoke(["run", project, "--to", "n_shout", "--json"]),
  );
  if (
    !result.ok ||
    result.response.finalOutputsByNode.n_shout.shouted.jsonValue !==
      "HELLO FROM ROWCALL"
  ) {
    throw new Error(`Installed run failed: ${JSON.stringify(result)}`);
  }
  const validated = JSON.parse(await invoke(["validate", project, "--json"]));
  if (!validated.ok) throw new Error("Installed validation failed");
  const python = `${project}/.venv/Scripts/python.exe`;
  // Confirm this did not accidentally use the checkout's editable Python package.
  await run(python, [
    "-c",
    "import importlib.util; assert importlib.util.find_spec('rowcall') is None",
  ], { env: cleanEnvironment, cwd: outside });
  await run(python, [
    "-c",
    "import pathlib,rowcall,sys; assert pathlib.Path(rowcall.__file__).resolve().is_relative_to(pathlib.Path(sys.argv[1]).resolve())",
    `${home}/.rowcall/bundled/python-package`,
  ], {
    env: {
      ...cleanEnvironment,
      PYTHONPATH: `${home}/.rowcall/bundled/python-package`,
    },
    cwd: outside,
  });
  await run(Deno.execPath(), ["run", "-A", "tools/smoke_binary.ts", installed]);

  // A damaged download must not replace a working installation.
  const bad = `${root}/${asset}`;
  await Deno.copyFile(artifact, bad);
  await Deno.writeTextFile(`${bad}.sha256`, `${"0".repeat(64)}  ${asset}\n`);
  const rejected = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-DownloadUrl",
      pathToFileURL(bad).href,
      "-InstallDir",
      installDir,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  if (rejected.success || await sha256(installed) !== hash) {
    throw new Error("Installer failed checksum protection");
  }
  if (await sha256(artifact) !== hash) {
    throw new Error("Artifact changed during smoke");
  }
  const endCommit = await run("git", ["rev-parse", "HEAD"]);
  const endStatus = await run("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (endCommit !== commit || sourceStatus || endStatus) {
    throw new Error("Native attestation requires an unchanged clean checkout");
  }
  await Deno.writeTextFile(
    `${artifact}.smoke-attestation.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        asset,
        sha256: hash,
        version,
        sourceCommit: commit,
        sourceDirty: false,
        nativeArchitecture: "x64",
      },
      null,
      2,
    ) + "\n",
  );
  console.info(
    "Windows installed-artifact smoke passed; wrote native attestation.",
  );
} finally {
  await Deno.remove(root, { recursive: true });
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    ...options,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${
        new TextDecoder().decode(result.stdout)
      }\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}
