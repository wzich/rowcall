import { assert, assertEquals, assertRejects } from "@std/assert";
import { validateReleaseArtifacts } from "./release.ts";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

type FixtureOptions = {
  omitX64?: boolean;
  x64Commit?: string;
  x64Dirty?: boolean;
  arm64Authorization?: "github-actions-workflow" | "diagnostic";
  arm64WorkflowRepository?: string;
  x64WorkflowRunId?: string;
  corruptArm64AfterAttestation?: boolean;
};

async function withReleaseFixture(
  options: FixtureOptions,
  run: (directory: string) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  try {
    await writeAttestedArtifact(
      directory,
      "nodebook-darwin-arm64",
      "arm64",
      commitA,
      false,
      options.arm64Authorization ?? "github-actions-workflow",
      "12345",
      options.arm64WorkflowRepository,
    );
    if (options.corruptArm64AfterAttestation) {
      await Deno.writeTextFile(
        `${directory}/nodebook-darwin-arm64`,
        "changed after smoke",
      );
    }
    if (!options.omitX64) {
      await writeAttestedArtifact(
        directory,
        "nodebook-darwin-x64",
        "x64",
        options.x64Commit ?? commitA,
        options.x64Dirty ?? false,
        "github-actions-workflow",
        options.x64WorkflowRunId ?? "12345",
      );
    }
    await run(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function writeAttestedArtifact(
  directory: string,
  asset: string,
  nativeArchitecture: "arm64" | "x64",
  sourceCommit: string,
  sourceDirty: boolean,
  authorization: "github-actions-workflow" | "diagnostic",
  workflowRunId: string,
  workflowRepository = "wzich/nodebook",
) {
  const binaryPath = `${directory}/${asset}`;
  await Deno.writeTextFile(binaryPath, `binary:${asset}`);
  const sha256 = await sha256Hex(binaryPath);
  await Deno.writeTextFile(
    `${binaryPath}.smoke-attestation.json`,
    `${
      JSON.stringify(
        {
          schemaVersion: 2,
          asset,
          sha256,
          version: "0.1.0",
          sourceCommit,
          sourceDirty,
          nativeArchitecture,
          authorization,
          workflowRunId: authorization === "github-actions-workflow"
            ? workflowRunId
            : null,
          workflowRunAttempt: authorization === "github-actions-workflow"
            ? "1"
            : null,
          workflowName: authorization === "github-actions-workflow"
            ? "Invited beta smoke"
            : null,
          workflowEvent: authorization === "github-actions-workflow"
            ? "workflow_dispatch"
            : null,
          workflowJob: authorization === "github-actions-workflow"
            ? "build-and-smoke"
            : null,
          workflowRef: authorization === "github-actions-workflow"
            ? `${workflowRepository}/.github/workflows/invited-beta-smoke.yml@refs/heads/main`
            : null,
          workflowRepository: authorization === "github-actions-workflow"
            ? workflowRepository
            : null,
          runnerArchitecture: authorization === "github-actions-workflow"
            ? nativeArchitecture === "arm64" ? "ARM64" : "X64"
            : null,
        },
        null,
        2,
      )
    }\n`,
  );
}

async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function runSmokeHelper(
  invocation: string,
  args: string[],
): Promise<Deno.CommandOutput> {
  return await new Deno.Command("sh", {
    args: [
      "-c",
      `. "$1"; ${invocation}`,
      "release-smoke-helper-test",
      `${Deno.cwd()}/packaging/release-smoke-helpers.sh`,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("architecture helper rejects x64 bytes labeled as arm64", async () => {
  const result = await runSmokeHelper(
    'verify_architecture_outputs "$2" "$3" "$4"',
    ["arm64", "x86_64", "Mach-O 64-bit executable x86_64"],
  );
  assert(!result.success);
  assert(
    new TextDecoder().decode(result.stderr).includes(
      "expected 'arm64'",
    ),
  );
});

Deno.test("hash helper rejects mutation of the tested fixture", async () => {
  const result = await runSmokeHelper(
    'verify_stable_smoke_hashes "$2" "$3" "$4" "$5"',
    ["a".repeat(64), "a".repeat(64), "b".repeat(64), "a".repeat(64)],
  );
  assert(!result.success);
  assert(
    new TextDecoder().decode(result.stderr).includes(
      "fixture changed",
    ),
  );
});

Deno.test("hash helper rejects mutation of the original artifact", async () => {
  const result = await runSmokeHelper(
    'verify_stable_smoke_hashes "$2" "$3" "$4" "$5"',
    ["a".repeat(64), "a".repeat(64), "a".repeat(64), "b".repeat(64)],
  );
  assert(!result.success);
  assert(
    new TextDecoder().decode(result.stderr).includes(
      "Original artifact changed",
    ),
  );
});

Deno.test("release gate accepts two same-source native-smoke attestations", async () => {
  await withReleaseFixture({}, async (directory) => {
    const identity = await validateReleaseArtifacts({
      directory,
      expectedVersion: "0.1.0",
      expectedSourceCommit: commitA,
    });
    assertEquals(identity.version, "0.1.0");
    assertEquals(identity.sourceCommit, commitA);
    assertEquals(identity.workflowRunId, "12345");
    assertEquals(identity.workflowRunAttempt, "1");
    assertEquals(Object.keys(identity.hashes).sort(), [
      "darwin-arm64",
      "darwin-x64",
    ]);
  });
});

Deno.test("release gate rejects a one-architecture smoke", async () => {
  await withReleaseFixture({ omitX64: true }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
        }),
      Error,
      "nodebook-darwin-x64",
    );
  });
});

Deno.test("release gate rejects attestations from different source commits", async () => {
  await withReleaseFixture({ x64Commit: commitB }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
        }),
      Error,
      "same workflow run, attempt, source commit, and version",
    );
  });
});

Deno.test("release gate rejects attestations from different workflow runs", async () => {
  await withReleaseFixture({ x64WorkflowRunId: "67890" }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
        }),
      Error,
      "same workflow run",
    );
  });
});

Deno.test("release gate rejects artifacts from a different checkout commit", async () => {
  await withReleaseFixture({}, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
          expectedSourceCommit: commitB,
        }),
      Error,
      "current checkout",
    );
  });
});

Deno.test("release gate rejects a dirty-source attestation", async () => {
  await withReleaseFixture({ x64Dirty: true }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
        }),
      Error,
      "dirty source tree",
    );
  });
});

Deno.test("release gate rejects a local diagnostic smoke", async () => {
  await withReleaseFixture(
    { arm64Authorization: "diagnostic" },
    async (directory) => {
      await assertRejects(
        () =>
          validateReleaseArtifacts({
            directory,
            expectedVersion: "0.1.0",
          }),
        Error,
        "diagnostic only",
      );
    },
  );
});

Deno.test("release gate rejects a workflow receipt from another repository", async () => {
  await withReleaseFixture(
    { arm64WorkflowRepository: "attacker/fork" },
    async (directory) => {
      await assertRejects(
        () =>
          validateReleaseArtifacts({
            directory,
            expectedVersion: "0.1.0",
          }),
        Error,
        "valid manual GitHub workflow receipt",
      );
    },
  );
});

Deno.test("release gate rejects an artifact changed after its smoke", async () => {
  await withReleaseFixture(
    { corruptArm64AfterAttestation: true },
    async (directory) => {
      await assertRejects(
        () =>
          validateReleaseArtifacts({
            directory,
            expectedVersion: "0.1.0",
          }),
        Error,
        "hash does not match",
      );
    },
  );
});
