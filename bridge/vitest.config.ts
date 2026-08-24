import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The core is pure and deterministic; nothing in the suite may reach the
    // network or the real clock. Providers are exercised through fixtures.
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/normalize/**", "src/coordinator/**", "src/push/**"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
