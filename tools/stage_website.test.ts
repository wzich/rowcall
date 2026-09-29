import { assertThrows } from "@std/assert";
import { validatePublishedManifest } from "./stage_website.ts";

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
