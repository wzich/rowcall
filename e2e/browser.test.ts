import { expect, type Page, test as base } from "@playwright/test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repository = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

type RowcallProject = { documentPath: string; url: string };

const test = base.extend<{ rowcall: RowcallProject }>({
  rowcall: async ({}, use, testInfo) => {
    await mkdir(join(repository, "tmp"), { recursive: true });
    const project = await mkdtemp(join(repository, "tmp", "browser-test-"));
    let server: ChildProcess | undefined;
    let serverLog = "";
    let fixtureReady = false;
    try {
      const python = process.env.ROWCALL_TEST_PYTHON ?? "python3";
      try {
        await run(python, ["-c", "import polars"], {
          cwd: repository,
          timeout: 30_000,
        });
      } catch (error) {
        throw new Error(
          "Browser tests need Python with Polars. Set ROWCALL_TEST_PYTHON to that interpreter.",
          { cause: error },
        );
      }
      await run("deno", ["run", "-A", "launcher.ts", "example", project], {
        cwd: repository,
        timeout: 30_000,
      });
      const documentPath = join(project, "graph.py");
      const port = await availablePort();
      const origin = `http://127.0.0.1:${port}`;
      const token = randomUUID();
      server = spawn("deno", [
        "run",
        "-A",
        "main.ts",
        "--document",
        documentPath,
        "--python",
        python,
        "--rowcall-python-package",
        repository,
        "--port",
        String(port),
        "--auth-token",
        token,
      ], { cwd: repository, stdio: ["ignore", "ignore", "pipe"] });
      server.stderr?.on("data", (chunk: Buffer) => {
        serverLog = (serverLog + chunk.toString()).slice(-64_000);
      });
      server.on("error", (error) => {
        serverLog += `\n${error.message}`;
      });
      await expect.poll(async () => {
        try {
          const response = await fetch(origin, {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          return response.status;
        } catch {
          return 0;
        }
      }, { timeout: 15_000, message: "built Rowcall server becomes ready" })
        .toBe(200);
      fixtureReady = true;
      await use({ documentPath, url: `${origin}/?token=${token}` });
    } finally {
      try {
        if (server) await stopServer(server);
        if (!fixtureReady || testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("server.log", {
            body: serverLog,
            contentType: "text/plain",
          });
        }
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    }
  },
});

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate test port");
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => error ? reject(error) : resolve())
  );
  return address.port;
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => server.kill("SIGKILL"), 3000);
    server.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

// Exercise the built app and real Python worker, without mocked HTTP responses.
test("edit, save, run, reload, and recover a branching example", async ({ page, rowcall }) => {
  const { documentPath, url } = rowcall;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  const editor = page.getByRole("textbox", {
    name: "Step Python code",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save", exact: true });
  const selectBranch = async () => {
    await page.getByRole("button", { name: "Fit View", exact: true })
      .click();
    await page.getByRole("heading", {
      name: "Find large orders",
      exact: true,
    }).click();
  };

  await test.step(
    "open the generated graph and inspect a real Python result",
    async () => {
      await expect(
        page.getByRole("heading", {
          name: "Summarize orders",
          exact: true,
        }),
      ).toBeVisible();
      await selectBranch();
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await expect(editor).toContainText(">= 50");
      await page.getByRole("button", { name: "Run", exact: true })
        .click();
      await page.getByRole("button", { name: "Results", exact: true })
        .click();
      await expect(page.getByRole("table").first()).toContainText(
        "64.99",
      );
    },
  );

  await test.step(
    "save an edit, reload the browser, and verify changed results",
    async () => {
      await page.getByRole("button", { name: "Code", exact: true })
        .click();
      await editor.fill(
        (await editor.innerText()).replace(">= 50", ">= 80"),
      );
      await save.click();
      await expect.poll(() => readFile(documentPath, "utf8")).toContain(
        ">= 80",
      );
      await expect(page.getByText("Saved", { exact: true }))
        .toBeVisible();
      await page.reload();
      await selectBranch();
      await expect(editor).toContainText(">= 80");
      await page.getByRole("button", { name: "Run", exact: true })
        .click();
      await page.getByRole("button", { name: "Results", exact: true })
        .click();
      await expect(page.getByRole("table").first()).toContainText("85");
      await expect(page.getByRole("table").first()).not.toContainText(
        "64.99",
      );
    },
  );

  await test.step(
    "reject invalid Python without changing the saved file",
    async () => {
      await page.getByRole("button", { name: "Code", exact: true })
        .click();
      const validBody = await editor.innerText();
      const savedSource = await readFile(documentPath, "utf8");
      await editor.fill("large_orders = (");
      await save.click();
      await expect(
        page.getByText(
          "Save failed: unsaved Python has a syntax error",
          { exact: true },
        ).first(),
      ).toBeVisible();
      await expect(editor).toContainText("large_orders = (");
      expect(await readFile(documentPath, "utf8")).toBe(savedSource);
      await editor.fill(validBody);
      await save.click();
      await expect(page.getByText("Saved", { exact: true }))
        .toBeVisible();
    },
  );

  await test.step(
    "reload external edits and protect a conflicting browser draft",
    async () => {
      await writeFile(
        documentPath,
        (await readFile(documentPath, "utf8")).replace(">= 80", ">= 70"),
      );
      await expect(editor).toContainText(">= 70", { timeout: 15_000 });
      await editor.fill(
        (await editor.innerText()).replace(">= 70", ">= 95"),
      );
      const externalSource = (await readFile(documentPath, "utf8"))
        .replace(">= 70", ">= 60");
      await writeFile(documentPath, externalSource);
      await expect(
        page.getByText("Document changed on disk.", { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      const checkedFreshness = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/document/status" &&
        response.request().method() === "GET"
      );
      await save.click();
      await (await checkedFreshness).finished();
      await expect(editor).toContainText(">= 95");
      expect(await readFile(documentPath, "utf8")).toBe(externalSource);
      await page.getByRole("button", {
        name: "Reload from disk",
        exact: true,
      }).click();
      await expect(editor).toContainText(">= 60");
      await page.getByRole("button", { name: "Run", exact: true })
        .click();
      await page.getByRole("button", { name: "Results", exact: true })
        .click();
      await expect(page.getByRole("table").first()).toContainText(
        "64.99",
      );
      expect(await readFile(documentPath, "utf8")).toBe(externalSource);
      expect(errors).toEqual([]);
    },
  );
});

// Delay/drop only the transport response; the real server still commits the save.
test("edits made during a save remain pending until the next save", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  const save = page.getByRole("button", { name: "Save", exact: true });
  const committed = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  await page.route("**/document/operations", async (route) => {
    const response = await route.fetch();
    committed.resolve();
    await releaseResponse.promise;
    await route.fulfill({ response });
  }, { times: 1 });

  try {
    await editor.fill((await editor.innerText()).replace(">= 50", ">= 80"));
    await save.click();
    await committed.promise;
    expect(await readFile(rowcall.documentPath, "utf8")).toContain(">= 80");
    await editor.fill((await editor.innerText()).replace(">= 80", ">= 95"));
  } finally {
    releaseResponse.resolve();
  }
  await expect(page.getByRole("button", { name: "Save", exact: true }))
    .toHaveText("Save •");
  await expect(editor).toContainText(">= 95");
  expect(await readFile(rowcall.documentPath, "utf8")).toContain(">= 80");
  await save.click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(rowcall.documentPath, "utf8")).toContain(">= 95");
});

test("an interrupted save blocks further writes until disk state is reloaded", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await page.route("**/document/operations", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });

  await editor.fill((await editor.innerText()).replace(">= 50", ">= 80"));
  await save.click();
  await expect(page.getByText("Save outcome unknown.", { exact: true }).first())
    .toBeVisible();
  expect(await readFile(rowcall.documentPath, "utf8")).toContain(">= 80");
  await expect(save).toBeDisabled();
  await expect(page.getByRole("button", { name: "Run graph", exact: true }))
    .toBeDisabled();
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  const blockedBody = await editor.innerText();
  await editor.press("End");
  await editor.press("x");
  await expect(editor).toHaveText(blockedBody, { useInnerText: true });
  await page.getByRole("button", {
    name: "Reload and inspect saved state",
    exact: true,
  }).click();
  await expect(save).toBeEnabled();
  await expect(editor).not.toHaveAttribute("aria-readonly", "true");
  await expect(editor).toContainText(">= 80");
  await editor.fill((await editor.innerText()).replace(">= 80", ">= 95"));
  await save.click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(rowcall.documentPath, "utf8")).toContain(">= 95");
});

async function openLargeOrders(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.getByRole("heading", { name: "Find large orders", exact: true })
    .click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  return page.getByRole("textbox", { name: "Step Python code", exact: true });
}

test("a slow disk reload cannot overwrite an edit made while it was loading", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  const loaded = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  await page.route("**/document", async (route) => {
    const response = await route.fetch();
    loaded.resolve();
    await releaseResponse.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  const externalSource = (await readFile(rowcall.documentPath, "utf8")).replace(
    ">= 50",
    ">= 60",
  );
  try {
    await writeFile(rowcall.documentPath, externalSource);
    await loaded.promise;
    await editor.fill((await editor.innerText()).replace(">= 50", ">= 95"));
  } finally {
    releaseResponse.resolve();
  }
  await expect(page.getByText("Document changed on disk.", { exact: true }))
    .toBeVisible();
  await expect(editor).toContainText(">= 95");
  expect(await readFile(rowcall.documentPath, "utf8")).toBe(externalSource);
  await page.getByRole("button", { name: "Reload from disk", exact: true })
    .click();
  await expect(editor).toContainText(">= 60");
});

test("paired previews preserve inputs and results while edits and failed runs retain context", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  const input = page.getByRole("region", {
    name: "Input preview",
    exact: true,
  });
  const output = page.getByRole("region", {
    name: "Output preview",
    exact: true,
  });
  const runStep = page.getByRole("button", { name: "Run", exact: true });
  await runStep.click();
  await expect(input.getByRole("table")).toContainText("28.4");
  await expect(output.getByRole("table")).toContainText("64.99");
  await expect(output.getByRole("table")).not.toContainText("28.4");
  await expect(page.getByRole("button", { name: "Code", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  const validCode = await editor.innerText();
  await editor.fill(
    validCode +
      '\nprint("diagnostic marker")\nraise ValueError("intentional preview failure")',
  );
  await expect(output).toContainText("Not updated");
  await expect(output.getByRole("table")).toContainText("64.99");
  await runStep.click();
  await expect(
    page.getByText("intentional preview failure", { exact: false }).first(),
  ).toBeVisible();
  await expect(input.getByRole("table")).toContainText("28.4");
  await expect(output.getByRole("table")).toContainText("64.99");
  await page.getByRole("button", { name: "Show graph overview" }).click();
  await page.getByRole("heading", { name: "Find large orders", exact: true })
    .click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(input.getByRole("table")).toContainText("28.4");
  await expect(output.getByRole("table")).toContainText("64.99");

  await page.getByRole("button", { name: /^Results/ }).click();
  await expect(page.getByRole("button", { name: "large_orders", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table").first()).toContainText("64.99");
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page.getByText("diagnostic marker", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: /^Results/ }).click();
  await page.getByRole("button", { name: "Open Code", exact: true }).click();
  await expect(editor.locator(".cm-activeLine")).toContainText(
    "raise ValueError",
  );
  await expect(editor.locator(".cm-error-line")).toContainText(
    "raise ValueError",
  );
  await expect(page.locator(".cm-lineNumbers .cm-error-gutter")).toBeVisible();
  await editor.fill(validCode);
  await expect(editor.locator(".cm-error-line")).toHaveCount(0);
  await runStep.click();
  await expect(output).not.toContainText("Not updated");
  await page.getByRole("button", { name: "Focus inspector", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Show graph", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show graph", exact: true }).click();
  const split = page.getByRole("separator", {
    name: "Resize code and previews",
    exact: true,
  });
  await split.focus();
  await split.press("ArrowLeft");
  await expect(split).toHaveAttribute("aria-valuenow", "52");
  await page.reload();
  await openLargeOrders(page, rowcall.url);
  await expect(
    page.getByRole("separator", {
      name: "Resize code and previews",
      exact: true,
    }),
  ).toHaveAttribute("aria-valuenow", "52");
});

test("trace is a one-off run option and graph outputs use sidebar navigation", async ({ page, rowcall }) => {
  await openLargeOrders(page, rowcall.url);
  await expect(page.getByRole("checkbox", { name: "Trace", exact: true }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Run options", exact: true }).last()
    .click();
  const traced = page.waitForRequest((request) =>
    request.method() === "POST" && request.postDataJSON()?.trace === true
  );
  await page.getByRole("button", { name: "Run with trace", exact: true })
    .click();
  await traced;
  await expect(page.getByRole("status").filter({ hasText: /^Step completed$/ }))
    .toBeVisible();
  const ordinary = page.waitForRequest((request) =>
    request.method() === "POST" && request.postDataJSON()?.trace === false
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await ordinary;
  await expect(page.getByRole("status").filter({ hasText: /^Step completed$/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show graph overview" }).click();
  await page.getByRole("button", { name: "Run graph", exact: true }).click();
  const nav = page.getByRole("navigation", {
    name: "Graph inspector navigation",
  });
  await expect(nav.getByRole("button", { name: /large_orders/ })).toBeVisible();
  await nav.getByRole("button", { name: /large_orders/ }).click();
  await expect(nav.getByRole("button", { name: /large_orders/ }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table")).toContainText("64.99");
});

test("Details persists step metadata and displays the renamed function", async ({ page, rowcall }) => {
  await openLargeOrders(page, rowcall.url);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("textbox", { name: "Step name", exact: true }).fill(
    "Review large orders",
  );
  await page.getByRole("textbox", { name: "Step description", exact: true })
    .fill("Orders selected for review.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("heading", { name: "Review large orders", exact: true })
    .first().click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Step name", exact: true }))
    .toHaveValue("Review large orders");
  await expect(
    page.getByRole("textbox", { name: "Step description", exact: true }),
  ).toHaveValue("Orders selected for review.");
  await expect(page.getByText("review_large_orders", { exact: true }).last())
    .toBeVisible();
});

test("node displays are individually selectable beside variables", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  await editor.fill(
    (await editor.innerText()) +
      '\ndisplay("first-only-marker", label="First display")\ndisplay("second-only-marker", label="Second display")',
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Step completed$/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Results", exact: true }).click();
  const nav = page.getByRole("navigation", {
    name: "Inspector navigation",
    exact: true,
  });
  await nav.getByRole("button", { name: "First display display", exact: true })
    .click();
  await expect(page.locator(".node-results")).toContainText(
    "first-only-marker",
  );
  await expect(page.getByText("second-only-marker", { exact: true })).not
    .toBeVisible();
  await nav.getByRole("button", { name: "Second display display", exact: true })
    .click();
  await expect(page.locator(".node-results")).toContainText(
    "second-only-marker",
  );
  await expect(page.getByText("first-only-marker", { exact: true })).not
    .toBeVisible();
});

test("canvas variable navigation replaces other result content on repeated clicks", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  const code = (await editor.innerText()) +
    '\nprint("navigation console marker")\ndisplay("navigation display marker", label="Navigation display")';
  await editor.fill(code);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Step completed$/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Results", exact: true }).click();
  const nav = page.getByRole("navigation", {
    name: "Inspector navigation",
    exact: true,
  });
  const canvasVariable = page.locator(".python-node-card")
    .filter({
      has: page.getByRole("heading", {
        name: "Find large orders",
        exact: true,
      }),
    })
    .getByText("large_orders", { exact: true });
  const results = page.locator(".node-results");
  const expectVariable = async () => {
    await canvasVariable.click();
    await expect(nav.getByRole("button", { name: "large_orders", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(results.getByRole("table")).toContainText("64.99");
  };
  for (const name of ["Console", "Navigation display display", "Console"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(results.getByRole("table")).toHaveCount(0);
    await expectVariable();
  }
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await editor.fill(code + '\nraise ValueError("navigation error marker")');
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Step failed$/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await nav.getByRole("button", { name: "Error", exact: true }).click();
  await expect(results.getByRole("table")).toHaveCount(0);
  await expectVariable();
});

test("graph failure toast opens Code from another inspector tab", async ({ page, rowcall }) => {
  const editor = await openLargeOrders(page, rowcall.url);
  await editor.fill(
    (await editor.innerText()) +
      '\nraise ValueError("toast navigation failure")',
  );
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Run graph", exact: true }).click();
  await page.getByRole("button", { name: /View error details$/ }).click();
  await expect(page.getByRole("button", { name: "Code", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeFocused();
  await expect(editor.locator(".cm-activeLine")).toContainText(
    "raise ValueError",
  );
  await expect(editor.locator(".cm-error-line")).toContainText(
    "raise ValueError",
  );
});

test("a failed traced attempt exposes Trace after an ordinary successful run", async ({ page, rowcall }) => {
  const marker = rowcall.documentPath + ".trace-marker";
  await writeFile(marker, "ready");
  const editor = await openLargeOrders(page, rowcall.url);
  await editor.fill(
    (await editor.innerText()) +
      `\nassert __import__("pathlib").Path(${
        JSON.stringify(marker)
      }).exists(), "trace marker missing"`,
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Step completed$/ }))
    .toBeVisible();
  await rm(marker);
  await page.getByRole("button", { name: "Run options", exact: true }).last()
    .click();
  await page.getByRole("button", { name: "Run with trace", exact: true })
    .click();
  await expect(page.getByRole("status").filter({ hasText: /^Step failed$/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await page.getByRole("button", { name: "Trace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trace", exact: true }))
    .toBeVisible();
});

test("header acknowledges clean saves and keeps appearance in its menu", async ({ page, rowcall }) => {
  await page.goto(rowcall.url);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toHaveText("Saved");
  await expect(save).toHaveText("Save");
  await save.click();
  await expect(save).toHaveText("Saved");
  await expect(page.getByRole("button", { name: /Switch to .* mode/ }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "More options", exact: true }).click();
  const toggle = page.getByRole("button", { name: /Switch to .* mode/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveCount(0);
});

test("runtime and shortcuts dismiss outside and with Escape", async ({ page, rowcall }) => {
  await page.goto(rowcall.url);
  const runtime = page.locator("summary").filter({ hasText: /Python [0-9]/ });
  await runtime.click();
  await expect(page.getByText("Runtime Details", { exact: true }))
    .toBeVisible();
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByText("Runtime Details", { exact: true }))
    .toBeVisible();
  await page.getByRole("heading", { name: "Rowcall", exact: true }).click();
  await expect(page.getByText("Runtime Details", { exact: true })).toBeHidden();
  await runtime.click();
  await page.keyboard.press("Escape");
  await expect(runtime).toBeFocused();
  await expect(page.getByText("Runtime Details", { exact: true })).toBeHidden();
  const shortcuts = page.locator("summary").filter({ hasText: /^Shortcuts$/ });
  await shortcuts.click();
  await expect(shortcuts.locator("..")).toHaveAttribute("open", "");
  await page.getByRole("heading", { name: "Rowcall", exact: true }).click();
  await expect(shortcuts.locator("..")).not.toHaveAttribute("open", "");
  await shortcuts.click();
  await page.keyboard.press("Escape");
  await expect(shortcuts).toBeFocused();
  await expect(shortcuts.locator("..")).not.toHaveAttribute("open", "");
});

test("initial graph view fits every measured node", async ({ page, rowcall }) => {
  await page.goto(rowcall.url);
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(3);
  await expect.poll(async () => {
    const canvas = await page.locator(".react-flow").boundingBox();
    if (!canvas) return false;
    const boxes = await Promise.all(
      (await nodes.all()).map((node) => node.boundingBox()),
    );
    return boxes.every((box) =>
      box && box.width > 0 &&
      box.x >= canvas.x && box.y >= canvas.y &&
      box.x + box.width <= canvas.x + canvas.width &&
      box.y + box.height <= canvas.y + canvas.height
    );
  }).toBe(true);
});
