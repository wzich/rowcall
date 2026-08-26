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
      requirementsPath: project.requirementsPath,
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
        requirementsPath: project.requirementsPath,
        requirementsPresent: true,
        requirementsStatus: "current",
        canSync: true,
      },
      updated: false,
    },
  );
});

Deno.test({
  name: "failed sync keeps the previous successful requirements fingerprint",
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
    assertEquals(await Deno.readTextFile(project.setupPath), previousSetup);
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
