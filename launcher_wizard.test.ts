import { join } from "node:path";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  collectProjectSetup,
  mergePackages,
  parseAdditionalPackages,
  starterSource,
  type WizardIO,
} from "./launcher_wizard.ts";
import { createNewDocument, resolveBareCommand } from "./launcher.ts";

Deno.test("package input accepts constraints and overrides checklist defaults", () => {
  assertEquals(parseAdditionalPackages("package[foo,bar]>=1, scipy"), [
    "package[foo,bar]>=1",
    "scipy",
  ]);
  assertEquals(parseAdditionalPackages("duckdb>=1.2,<2, scipy"), [
    "duckdb>=1.2,<2",
    "scipy",
  ]);
  assertEquals(mergePackages(["polars"], ["polars==1.0", "scipy"]), [
    "polars==1.0",
    "scipy",
  ]);
  for (
    const value of [
      "--index-url evil",
      "numpy,",
      "numpy\n-r bad",
      "https://example.com/pkg",
    ]
  ) {
    assertThrows(() => parseAdditionalPackages(value));
  }
});

Deno.test("each starter executes and displays its sample through the Python runtime", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const packages of [["polars"], ["pandas"], []]) {
      const path = `${dir}/graph.py`;
      await Deno.writeTextFile(path, starterSource(packages));
      const result = await new Deno.Command("python3", {
        args: ["-m", "rowcall", "run", path, "--json=summary"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const payload = JSON.parse(new TextDecoder().decode(result.stdout));
      assertEquals(payload.response.executedNodeIds, ["n_start"]);
      const displays = payload.response.nodes[0].displays;
      assertEquals(displays.length, 1);
      if (packages.length) assertEquals(displays[0].table.rowCount, 3);
      else assertStringIncludes(displays[0].repr, "Welcome to Rowcall");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bare invocation detects only the current directory and stays noninteractive in scripts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals((await resolveBareCommand(dir, true)).kind, "start");
    await Deno.writeTextFile(
      `${dir}/graph.py`,
      "invalid Python still opens for repair",
    );
    assertEquals((await resolveBareCommand(dir, true)).kind, "launch");
    assertEquals((await resolveBareCommand(dir, false)).kind, "help");
    await Deno.mkdir(`${dir}/data`);
    assertEquals((await resolveBareCommand(`${dir}/data`, true)).kind, "start");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function scriptedIO(
  answers: Array<string | null>,
  selected: string[] | null = ["polars"],
): WizardIO {
  return {
    ask: (_message, defaultValue) => {
      if (!answers.length) throw new Error("Unexpected prompt");
      const answer = answers.shift();
      return answer === "" && defaultValue ? defaultValue : answer!;
    },
    selectPackages: () => Promise.resolve(selected),
    write: () => {},
  };
}

Deno.test("wizard confirms a plan without writes, cancels, and reprompts invalid choices", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const plan = await collectProjectSetup(
      scriptedIO(["analysis", "", "duckdb>=1.2, scipy", "yes"]),
      dir,
    );
    assertEquals(plan, {
      directory: join(dir, "analysis"),
      packages: ["polars", "duckdb>=1.2", "scipy"],
    });
    await assertRejects(
      () => Deno.stat(`${dir}/analysis`),
      Deno.errors.NotFound,
    );
    assertEquals(
      await collectProjectSetup(scriptedIO(["analysis", "", "", "n"]), dir),
      null,
    );
    assertEquals(await collectProjectSetup(scriptedIO([null]), dir), null);
    assertEquals(
      await collectProjectSetup(scriptedIO(["analysis", ""], null), dir),
      null,
    );
    await Deno.mkdir(`${dir}/existing`);
    const retry = await collectProjectSetup(
      scriptedIO([
        "../bad",
        "existing",
        "",
        "fresh",
        "",
        "--bad",
        "pandas>=2,<3",
        "maybe",
        "",
      ]),
      dir,
    );
    assertEquals(retry?.directory, join(dir, "fresh"));
    assertEquals(retry?.packages, ["polars", "pandas>=2,<3"]);
    assertEquals(Array.from(Deno.readDirSync(dir)).map((entry) => entry.name), [
      "existing",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("starter follows packages and persists its Start title and description", async () => {
  assertStringIncludes(
    starterSource(["polars", "pandas"]),
    "import polars as pl\nfrom rowcall import node",
  );
  assertStringIncludes(
    starterSource(["pandas>=2"]),
    "import pandas as pd\nfrom rowcall import node",
  );
  assertStringIncludes(starterSource([]), "display(message)");
  const dir = await Deno.makeTempDir();
  try {
    await createNewDocument(`${dir}/project`, ["pandas>=2"]);
    assertEquals(
      await Deno.readTextFile(`${dir}/project/requirements.txt`),
      "pandas>=2\n",
    );
    const metadata = JSON.parse(
      await Deno.readTextFile(`${dir}/project/graph.rowcall.json`),
    );
    assertEquals(metadata.nodes[0].title, "Start");
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/project/graph.py`),
      "display(df)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
