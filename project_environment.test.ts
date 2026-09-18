import { assert, assertEquals, assertRejects } from "@std/assert";
import { getVenvPythonPath } from "./launcher_paths.ts";
import {
  inspectProjectEnvironment,
  ProjectEnvironmentSyncError,
  projectRequirementsFingerprint,
  syncProjectEnvironment,
  writeCompleteProjectEnvironmentSetup,
} from "./project_environment.ts";

Deno.test("project environment status detects changed requirements", async () => {
  const project = await createProjectEnvironment("alpha==1\n");
  const fingerprint = await projectRequirementsFingerprint(
    project.requirementsPath,
  );
  await writeCompleteProjectEnvironmentSetup(project.setupPath, fingerprint);

  assertEquals(
    await inspectProjectEnvironment(project.documentPath, project.pythonPath),
    {
      ownership: "rowcall",
      requirementsPath: project.requirementsPath.replaceAll("\\", "/"),
      requirementsPresent: true,
      requirementsStatus: "current",
      canSync: true,
    },
  );

  await Deno.writeTextFile(project.requirementsPath, "alpha==2\n");
  const changed = await inspectProjectEnvironment(
    project.documentPath,
    project.pythonPath,
  );
  assertEquals(changed.requirementsStatus, "changed");
});

Deno.test("project environment status never manages a different interpreter", async () => {
  const project = await createProjectEnvironment("");
  await writeCompleteProjectEnvironmentSetup(
    project.setupPath,
    await projectRequirementsFingerprint(project.requirementsPath),
  );

  const status = await inspectProjectEnvironment(
    project.documentPath,
    "/another/environment/python",
  );
  assertEquals(status.ownership, "user");
  assertEquals(status.requirementsStatus, "unknown");
  assertEquals(status.canSync, false);
});

Deno.test("sync rejects unmarked or unselected environments without modifying them", async () => {
  const project = await createProjectEnvironment("do-not-install\n");
  await assertRejects(
    () => syncProjectEnvironment(project.documentPath, project.pythonPath),
    ProjectEnvironmentSyncError,
    "only installs dependencies into project environments it created",
  );
  await assertRejects(() => Deno.stat(project.setupPath), Deno.errors.NotFound);

  const marker = "incomplete\n";
  await Deno.writeTextFile(project.setupPath, marker);
  await assertRejects(
    () => syncProjectEnvironment(project.documentPath, "/user/python"),
    ProjectEnvironmentSyncError,
    "only installs dependencies into project environments it created",
  );
  assertEquals(await Deno.readTextFile(project.setupPath), marker);
});

Deno.test("sync records an absent requirements file without running pip", async () => {
  const project = await createProjectEnvironment(null);
  await Deno.writeTextFile(project.setupPath, "complete\n");

  const synced = await syncProjectEnvironment(
    project.documentPath,
    project.pythonPath,
  );
  assertEquals(synced.updated, true);
  assertEquals(synced.environment.requirementsPresent, false);
  assertEquals(synced.environment.requirementsStatus, "current");
  assertEquals(
    await Deno.readTextFile(project.setupPath),
    "complete\nrequirements-sha256=absent\n",
  );
});

Deno.test("sync skips pip when the requirements fingerprint is current", async () => {
  const project = await createProjectEnvironment("unpinned-package\n");
  await writeCompleteProjectEnvironmentSetup(
    project.setupPath,
    await projectRequirementsFingerprint(project.requirementsPath),
  );

  // The test environment intentionally has no Python executable. A repeated
  // pip invocation would fail instead of returning this no-op result.
  assertEquals(
    await syncProjectEnvironment(project.documentPath, project.pythonPath),
    {
      environment: {
        ownership: "rowcall",
        requirementsPath: project.requirementsPath.replaceAll("\\", "/"),
        requirementsPresent: true,
        requirementsStatus: "current",
        canSync: true,
      },
      updated: false,
    },
  );
});

Deno.test({
  name: "sync resolves relative document and dependency paths from the project",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const project = await createProjectEnvironment("./local-dependency.txt\n");
    const projectDirectory = project.documentPath.slice(0, -"/graph.py".length);
    await Deno.writeTextFile(
      `${projectDirectory}/local-dependency.txt`,
      "local",
    );
    await Deno.writeTextFile(project.setupPath, "incomplete\n");
    // Check both paths the installer consumes, without network or a real pip
    // install: its requirements argument and a project-relative dependency.
    await Deno.writeTextFile(
      project.pythonPath,
      `#!/bin/sh
set -eu
test "$1" = "-m"
test "$2" = "pip"
test "$3" = "install"
test "$4" = "-r"
test "$(cat "$(cat "$5")")" = "local"
`,
      { mode: 0o700 },
    );

    const originalDirectory = Deno.cwd();
    const separator = projectDirectory.lastIndexOf("/");
    const relativeDirectory = projectDirectory.slice(separator + 1);
    try {
      Deno.chdir(projectDirectory.slice(0, separator));
      const synced = await syncProjectEnvironment(
        `${relativeDirectory}/graph.py`,
        getVenvPythonPath(`${relativeDirectory}/.venv`),
      );
      assertEquals(synced.updated, true);
      assertEquals(synced.environment.requirementsStatus, "current");
    } finally {
      Deno.chdir(originalDirectory);
      await Deno.remove(projectDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "failed sync marks the environment incomplete",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const project = await createProjectEnvironment(
      "missing-package @ file:///definitely/missing/package\n",
    );
    const previousSetup = "complete\nrequirements-sha256=previous\n";
    await Deno.writeTextFile(project.setupPath, previousSetup);

    const error = await assertRejects(
      () => syncProjectEnvironment(project.documentPath, project.pythonPath),
      ProjectEnvironmentSyncError,
    );
    assert(error.message.length > 0);
    assertEquals(await Deno.readTextFile(project.setupPath), "incomplete\n");
  },
});

Deno.test({
  name:
    "failed install retries after requirements revert and edits during install stay changed",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const project = await createProjectEnvironment("original\n");
    await writeCompleteProjectEnvironmentSetup(
      project.setupPath,
      await projectRequirementsFingerprint(project.requirementsPath),
    );
    await Deno.writeTextFile(
      project.pythonPath,
      `#!/bin/sh
set -eu
if [ "$(cat "$5")" = "broken" ]; then exit 1; fi
printf 'changed-during-install\\n' > "$5"
`,
      { mode: 0o700 },
    );
    await Deno.writeTextFile(project.requirementsPath, "broken\n");
    await assertRejects(
      () => syncProjectEnvironment(project.documentPath, project.pythonPath),
      ProjectEnvironmentSyncError,
    );
    await Deno.writeTextFile(project.requirementsPath, "original\n");
    const startingHash = await projectRequirementsFingerprint(
      project.requirementsPath,
    );
    const result = await syncProjectEnvironment(
      project.documentPath,
      project.pythonPath,
    );
    assertEquals(result.updated, true);
    assertEquals(result.environment.requirementsStatus, "changed");
    assertEquals(
      await Deno.readTextFile(project.setupPath),
      `complete\nrequirements-sha256=${startingHash}\n`,
    );
  },
});

Deno.test({
  name: "failed sync retains only a bounded tail of installer output",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const project = await createProjectEnvironment("verbose-package\n");
    await Deno.writeTextFile(
      project.setupPath,
      "complete\nrequirements-sha256=outdated\n",
    );
    await Deno.writeTextFile(
      project.pythonPath,
      `#!/bin/sh
printf 'stdout-start\\n'
printf 'stderr-start\\n' >&2
i=0
while [ "$i" -lt 4000 ]; do
  printf 'stdout-noise-%04d-abcdefghijklmnopqrstuvwxyz\\n' "$i"
  printf 'stderr-noise-%04d-abcdefghijklmnopqrstuvwxyz\\n' "$i" >&2
  i=$((i + 1))
done
printf 'stdout-tail\\n'
printf 'stderr-tail\\n' >&2
exit 1
`,
      { mode: 0o700 },
    );

    const error = await assertRejects(
      () => syncProjectEnvironment(project.documentPath, project.pythonPath),
      ProjectEnvironmentSyncError,
    );
    assert(error.output.length <= 20_000);
    assert(error.output.includes("stderr-tail"), error.output || error.message);
    assert(!error.output.includes("stderr-start"));
  },
});

async function createProjectEnvironment(requirements: string | null) {
  const directory = await Deno.makeTempDir();
  const documentPath = `${directory}/graph.py`;
  const requirementsPath = `${directory}/requirements.txt`;
  const venvDirectory = `${directory}/.venv`;
  const pythonPath = getVenvPythonPath(venvDirectory);
  const setupPath = `${venvDirectory}/.rowcall-setup`;
  await Deno.mkdir(
    Deno.build.os === "windows"
      ? `${venvDirectory}/Scripts`
      : `${venvDirectory}/bin`,
    { recursive: true },
  );
  await Deno.writeTextFile(documentPath, "print('rowcall')\n");
  if (requirements !== null) {
    await Deno.writeTextFile(requirementsPath, requirements);
  }
  return {
    documentPath,
    requirementsPath,
    pythonPath,
    setupPath,
  };
}
