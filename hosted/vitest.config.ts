import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Hosted tests use Web Crypto and an in-memory store. They must never reach
    // Neon, Bambu Cloud, TRMNL, or any other network endpoint.
    environment: "node",
  },
});
