import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration specs boot a real Postgres. Keep them serial and patient.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration specs share one Postgres schema. Run spec files serially.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
})
