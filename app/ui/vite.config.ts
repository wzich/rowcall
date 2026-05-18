import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // TODO: Add manual chunking if the combined React Flow + CodeMirror bundle
  // becomes a real first-load problem after the UI grows beyond this POC.
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // TODO: Move this target into environment-specific config if the local
      // API port stops being fixed during development.
      "/inspect": "http://localhost:8000",
      "/run-node": "http://localhost:8000",
      "/run-to-node": "http://localhost:8000",
      "/run-graph": "http://localhost:8000",
      "/documents": "http://localhost:8000",
    },
  },
});
