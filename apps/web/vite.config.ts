import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // The budget that matters is the initial shell, which stays around 90 kB gzip. MapLibre is
    // ~800 kB raw but lives in its own lazily-loaded chunk that only map surfaces pull in, so
    // the warning threshold is raised past it deliberately rather than left to fire every build.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          // MapLibre is large and only needed on map surfaces, so it must not be in the shell.
          maplibre: ["maplibre-gl"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  server: {
    port: 5173,
    /*
     * Local development only. Deployed builds call the Worker origin directly via VITE_API_URL;
     * this proxy exists so `npm run dev` can use the same relative `/api` path against a local
     * `wrangler dev` without a second build configuration.
     */
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
