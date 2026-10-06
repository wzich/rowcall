import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  readPublishedWindowsInstaller,
  validatePublishedManifest,
} from "./stage_website.ts";

function manifest() {
  return {
    version: "0.1.1",
    downloads: Object.fromEntries(
      ["darwin-arm64", "darwin-x64"].map((platform) => [
        platform,
        {
          url: `https://releases.rowcall.io/v0.1.1/rowcall-${platform}`,
          sha256: "a".repeat(64),
        },
      ]),
    ),
  };
}

Deno.test("website staging accepts published release metadata", () => {
  validatePublishedManifest(manifest());
});
Deno.test("website staging rejects missing, mismatched, or untrusted downloads", () => {
  assertThrows(() => validatePublishedManifest(null));
  const missing = manifest();
  delete missing.downloads["darwin-x64"];
  assertThrows(() => validatePublishedManifest(missing));
  const mismatched = manifest();
  mismatched.version = "0.2.0";
  assertThrows(() => validatePublishedManifest(mismatched));
  const untrusted = manifest();
  untrusted.downloads["darwin-arm64"].url = "https://example.com/binary";
  assertThrows(() => validatePublishedManifest(untrusted));
  const invalidHash = manifest();
  invalidHash.downloads["darwin-arm64"].sha256 = "";
  assertThrows(() => validatePublishedManifest(invalidHash));
});

Deno.test("website staging validates optional Windows downloads", () => {
  const value = manifest();
  value.downloads["windows-x64"] = {
    url: "https://releases.rowcall.io/v0.1.1/rowcall-windows-x64.exe",
    sha256: "b".repeat(64),
  };
  validatePublishedManifest(value);
  value.downloads["windows-x64"].url = "https://example.com/binary";
  assertThrows(() => validatePublishedManifest(value));
});

Deno.test("website staging preserves Windows installers and fails closed when unavailable", async () => {
  const legacy = manifest();
  assertEquals(
    await readPublishedWindowsInstaller(legacy, () => {
      throw new Error("Unexpected fetch");
    }),
    null,
  );
  const windows = { downloads: { "windows-x64": {} } };
  const installer = "[CmdletBinding()]\nparam()\n";
  assertEquals(
    await readPublishedWindowsInstaller(
      windows,
      () => Promise.resolve(new Response(installer)),
    ),
    installer,
  );
  await assertRejects(
    () =>
      readPublishedWindowsInstaller(
        windows,
        () => Promise.resolve(new Response("missing", { status: 404 })),
      ),
    Error,
    "Cannot read",
  );
  await assertRejects(
    () =>
      readPublishedWindowsInstaller(
        windows,
        () => Promise.resolve(new Response("<html>not an installer</html>")),
      ),
    Error,
    "Invalid published",
  );
});
