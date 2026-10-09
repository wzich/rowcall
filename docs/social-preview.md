# Homepage social preview

The homepage uses `https://rowcall.io/social-preview.png` for Open Graph and
Twitter's `summary_large_image` card. The exported PNG is 1200 × 630 pixels. Its
editable source is `tools/social-preview/index.html`.

The design preserves the homepage's graph markup, charcoal background, mint
connections, and lavender ports, with spacing and type sized for a social card.
The original Orders / Customers → Join datasets → Revenue by segment example is
in `site/index.html`. If that example changes, update the editable card too.

## Render

Use Node.js 22+ and the existing pinned Playwright development dependency:

```sh
cd e2e
npm ci
npx playwright install chromium
cd ..
node e2e/render-social-preview.mjs
```

The script works from any current directory and writes:

- `site/social-preview.png`: committed public image, exactly 1200 × 630.
- `.local/social-preview/thumbnail.png`: ignored 400 × 210 review image.

Open `tools/social-preview/index.html` in a browser to edit and preview. Inter's
Latin variable font is bundled locally to keep the main typography consistent
without external requests. It comes from `@fontsource-variable/inter@5.2.8`; its
SIL Open Font License is in `tools/social-preview/fonts/OFL.txt`. Small code
samples use the platform monospace font.

## Website verification and publication

Stage the website using the same command as `.github/workflows/website.yml`:

```sh
deno run --allow-read --allow-write=dist --allow-net=rowcall.io tools/stage_website.ts
```

This copies the public PNG and HTML into `dist/website` and preserves the
currently published download manifest and installers. It needs read access to
`rowcall.io`; do not replace the production manifest with a fixture if staging
cannot fetch it. The editable design and font stay outside the public site.

Review the PNG at full size and thumbnail size. Check the staged HTML's
canonical URL, Open Graph tags, and Twitter tags, then serve `dist/website`
locally and verify the image returns `image/png` and has the declared
dimensions.

Publication is separate: after approval, the normal main-branch Website workflow
publishes `site/**` changes to Cloudflare Pages. Until publication, sharing the
homepage still uses its existing metadata. After publication, verify the public
HTML and image URL are reachable by social crawlers. Existing cached cards may
need to be refreshed by the sharing platform.
