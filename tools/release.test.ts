import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  validateReleaseArtifacts,
  validateReleaseManifest,
} from "./release.ts";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

type FixtureOptions = {
  omitX64?: boolean;
  sourceCommit?: string;
  sourceDirty?: boolean;
  corruptArm64AfterSmoke?: boolean;
};

async function withReleaseFixture(
  options: FixtureOptions,
  run: (directory: string) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  try {
    const arm64Path = `${directory}/nodebook-darwin-arm64`;
    await Deno.writeTextFile(arm64Path, "binary:nodebook-darwin-arm64");
    if (!options.omitX64) {
      await Deno.writeTextFile(
        `${directory}/nodebook-darwin-x64`,
        "binary:nodebook-darwin-x64",
      );
    }
    await writeSmokeAttestation(
      arm64Path,
      options.sourceCommit ?? commitA,
      options.sourceDirty ?? false,
    );
    if (options.corruptArm64AfterSmoke) {
      await Deno.writeTextFile(arm64Path, "changed after smoke");
    }
    await run(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function writeSmokeAttestation(
  binaryPath: string,
  sourceCommit: string,
  sourceDirty: boolean,
) {
  const sha256 = await sha256Hex(binaryPath);
  await Deno.writeTextFile(
    `${binaryPath}.smoke-attestation.json`,
    `${
      JSON.stringify(
        {
          schemaVersion: 1,
          asset: "nodebook-darwin-arm64",
          sha256,
          version: "0.1.0",
          sourceCommit,
          sourceDirty,
          nativeArchitecture: "arm64",
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
    new TextDecoder().decode(result.stderr).includes("expected 'arm64'"),
  );
});

Deno.test("hash helper rejects mutation of the tested fixture", async () => {
  const result = await runSmokeHelper(
    'verify_stable_smoke_hashes "$2" "$3" "$4" "$5"',
    ["a".repeat(64), "a".repeat(64), "b".repeat(64), "a".repeat(64)],
  );
  assert(!result.success);
  assert(
    new TextDecoder().decode(result.stderr).includes("fixture changed"),
  );
});

Deno.test("release gate accepts a native smoke plus both builds", async () => {
  await withReleaseFixture({}, async (directory) => {
    const identity = await validateReleaseArtifacts({
      directory,
      expectedVersion: "0.1.0",
      expectedSourceCommit: commitA,
      expectedNativeArchitecture: "arm64",
    });
    assertEquals(identity.version, "0.1.0");
    assertEquals(identity.sourceCommit, commitA);
    assertEquals(identity.nativeSmokedAsset, "nodebook-darwin-arm64");
    assertEquals(Object.keys(identity.hashes).sort(), [
      "darwin-arm64",
      "darwin-x64",
    ]);
  });
});

Deno.test("release gate rejects a missing cross-build", async () => {
  await withReleaseFixture({ omitX64: true }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
          expectedNativeArchitecture: "arm64",
        }),
      Error,
      "nodebook-darwin-x64",
    );
  });
});

Deno.test("release gate rejects artifacts from a different checkout", async () => {
  await withReleaseFixture({ sourceCommit: commitB }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
          expectedSourceCommit: commitA,
          expectedNativeArchitecture: "arm64",
        }),
      Error,
      "current checkout",
    );
  });
});

Deno.test("release gate rejects a dirty native smoke", async () => {
  await withReleaseFixture({ sourceDirty: true }, async (directory) => {
    await assertRejects(
      () =>
        validateReleaseArtifacts({
          directory,
          expectedVersion: "0.1.0",
          expectedNativeArchitecture: "arm64",
        }),
      Error,
      "dirty source tree",
    );
  });
});

Deno.test("release gate rejects an artifact changed after smoke", async () => {
  await withReleaseFixture(
    { corruptArm64AfterSmoke: true },
    async (directory) => {
      await assertRejects(
        () =>
          validateReleaseArtifacts({
            directory,
            expectedVersion: "0.1.0",
            expectedNativeArchitecture: "arm64",
          }),
        Error,
        "hash does not match",
      );
    },
  );
});

Deno.test("release manifest accepts the prepared binary hashes", () => {
  validateReleaseManifest(
    {
      version: "0.1.0",
      downloads: {
        "darwin-arm64": {
          url: "https://releases.nodebook.rodeo/v0.1.0/nodebook-darwin-arm64",
          sha256: "a".repeat(64),
        },
        "darwin-x64": {
          url: "https://releases.nodebook.rodeo/v0.1.0/nodebook-darwin-x64",
          sha256: "b".repeat(64),
        },
      },
    },
    {
      version: "0.1.0",
      identity: {
        version: "0.1.0",
        sourceCommit: commitA,
        nativeSmokedAsset: "nodebook-darwin-arm64",
        hashes: {
          "darwin-arm64": "a".repeat(64),
          "darwin-x64": "b".repeat(64),
        },
      },
    },
  );
});

Deno.test("release manifest rejects a stale binary hash", () => {
  assertThrows(
    () =>
      validateReleaseManifest(
        {
          version: "0.1.0",
          downloads: {
            "darwin-arm64": {
              url:
                "https://releases.nodebook.rodeo/v0.1.0/nodebook-darwin-arm64",
              sha256: "c".repeat(64),
            },
            "darwin-x64": {
              url: "https://releases.nodebook.rodeo/v0.1.0/nodebook-darwin-x64",
              sha256: "b".repeat(64),
            },
          },
        },
        {
          version: "0.1.0",
          identity: {
            version: "0.1.0",
            sourceCommit: commitA,
            nativeSmokedAsset: "nodebook-darwin-arm64",
            hashes: {
              "darwin-arm64": "a".repeat(64),
              "darwin-x64": "b".repeat(64),
            },
          },
        },
      ),
    Error,
    "does not match the prepared release",
  );
});
