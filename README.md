# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Deno/Hono API for inspecting and running graph-shaped Python notebooks,
plus a Vite/React UI prototype for rendering graphs on a canvas.

## Run Locally

Start the Deno API:

```sh
deno task dev
```

Start the React canvas UI in another terminal:

```sh
deno task ui:dev
```

The UI is served by Vite at `http://127.0.0.1:5173/` and proxies `/inspect`
requests to the API at `http://127.0.0.1:8000/`.

## Build The UI

```sh
deno task ui:build
```

The build output is written to `app/ui/dist/`. The existing Deno API still
serves the older static inspector; serving the React build from Hono is a future
step.
