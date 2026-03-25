import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/db/migrate-cli.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // The shared contract package ships as TypeScript source, so it has to be
  // compiled into the bundle rather than resolved at runtime.
  noExternal: ["@hearth/shared"],
})
