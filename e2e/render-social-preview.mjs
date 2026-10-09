import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const preview = new URL("tools/social-preview/index.html", root);
const output = fileURLToPath(new URL("site/social-preview.png", root));
const qa = fileURLToPath(new URL(".local/social-preview/", root));
await mkdir(qa, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.goto(preview.href);
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.evaluate(() => document.fonts.check("500 58px Inter")))) {
    throw new Error("The bundled Inter font did not load");
  }
  const size = await page.locator(".card").boundingBox();
  if (size?.width !== 1200 || size?.height !== 630) {
    throw new Error("Social preview must be exactly 1200 × 630");
  }
  await page.screenshot({ path: output, animations: "disabled" });
  // Inspect the actual exported PNG at a realistic small feed width.
  await page.setViewportSize({ width: 400, height: 210 });
  await page.setContent(
    '<style>body{margin:0}img{display:block;width:400px;height:210px}</style><img alt="Rowcall preview">',
  );
  await page.locator("img").evaluate(
    (img, src) =>
      new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = src;
      }),
    new URL("site/social-preview.png", root).href,
  );
  await page.screenshot({ path: `${qa}/thumbnail.png` });
  console.log(
    `Rendered ${output} (1200 × 630); thumbnail: ${qa}/thumbnail.png`,
  );
} finally {
  await browser.close();
}
