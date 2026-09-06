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
  await expect(page.getByText("Unsaved changes", { exact: true }))
    .toBeVisible();
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
