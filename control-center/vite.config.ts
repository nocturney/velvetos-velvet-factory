import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const controlTarget = process.env.VELVETOS_CONTROL_API_URL || "http://127.0.0.1:8080";
const controlToken = process.env.VELVETOS_CONTROL_API_TOKEN || "";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api/control": {
        target: controlTarget,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/control/, ""),
        configure: (proxy) => {
          if (controlToken) {
            proxy.on("proxyReq", (request) => {
              request.setHeader("Authorization", `Bearer ${controlToken}`);
            });
          }
        },
      },
    },
  },
});
