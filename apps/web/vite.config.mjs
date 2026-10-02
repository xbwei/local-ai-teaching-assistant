import { defineConfig } from "vite";

const smokeApiPort = process.env.LAITA_SMOKE_API_PORT;
if (
  smokeApiPort !== undefined &&
  (!/^\d{4,5}$/u.test(smokeApiPort) ||
    Number(smokeApiPort) < 1024 ||
    Number(smokeApiPort) > 65535)
)
  throw new Error("Invalid smoke API port");
const apiOrigin = `http://127.0.0.1:${smokeApiPort ?? "3100"}`;

export default defineConfig({
  // Local development/preview only, not the private deployment/access design.
  server: { proxy: { "/ready": apiOrigin } },
  preview: { proxy: { "/ready": apiOrigin } },
});
