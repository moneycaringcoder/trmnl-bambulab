import { defineConfig } from "vitest/config";

const liquidTextPlugin = {
  name: "liquid-text",
  transform(source: string, id: string) {
    if (!id.endsWith(".liquid")) {
      return null;
    }

    return {
      code: `export default ${JSON.stringify(source)};`,
      map: null,
    };
  },
};

export default defineConfig({
  plugins: [liquidTextPlugin],
  test: {
    include: ["test/**/*.test.{ts,js}"],
    // Hosted tests use Web Crypto, an in-memory store, and a local DOM harness.
    // They must never reach Neon, Bambu Cloud, TRMNL, or any other network
    // endpoint.
  },
});
