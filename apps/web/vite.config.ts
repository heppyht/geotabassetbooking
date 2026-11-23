import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/geotabassetbooking/",
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: true },
  define: {
    __DIAGNOSTICS_ENABLED__: false,
  },
});
