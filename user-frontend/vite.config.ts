import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = "http://localhost:18081";

export default defineConfig({
  base: "/user/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
});
