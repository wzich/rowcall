# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Deno/Hono API for editing and running graph-shaped Python notebooks, plus
a Vite/React UI for editing graphs on a canvas.

## Run Locally

Start the Deno API:

```sh
deno task dev
```

By default this edits `examples/scratch.nodebook.json`. To edit another local
document during development, pass a `.nodebook.json` path through the task:

```sh
deno task dev -- path/to/analysis.nodebook.json
```

If the document does not exist, Nodebook creates it with one blank Python node.

Start the React canvas UI in another terminal:

```sh
deno task ui:dev
```

The UI is served by Vite at `http://127.0.0.1:5173/` and proxies document,
inspection, and execution requests to the API at `http://127.0.0.1:8000/`.

## Build And Serve The UI

```sh
deno task ui:build
```

The build output is written to `app/ui/dist/`. After building, the Deno/Hono
server serves the React app from `http://127.0.0.1:8000/` while continuing to
handle document, inspection, and execution API routes.

Use Vite for active UI development. Use the Hono-served build when you want a
single local server or a production-style static app host.
