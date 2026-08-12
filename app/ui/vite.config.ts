import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiOrigin = Deno.env.get("NODEBOOK_DEV_API_ORIGIN") ??
  "http://127.0.0.1:8000";
const authToken = Deno.env.get("NODEBOOK_DEV_AUTH_TOKEN");
const uiPort = Number(Deno.env.get("NODEBOOK_DEV_UI_PORT") ?? "5173");
const apiRoutes = [
  "/document",
  "/run-node",
  "/run-to-node",
  "/run-graph",
  "/results",
  "/runtime",
];

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // TODO: Add manual chunking if the combined React Flow + CodeMirror bundle
  // becomes a real first-load problem after the UI grows beyond this POC.
  server: {
    host: "127.0.0.1",
    port: uiPort,
    strictPort: true,
    proxy: Object.fromEntries(
      apiRoutes.map((route) => [
        route,
        {
          target: apiOrigin,
          ...(authToken ? { headers: { "X-Nodebook-Token": authToken } } : {}),
        },
      ]),
    ),
  },
});
