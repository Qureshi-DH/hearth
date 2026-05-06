import { defineConfig } from "tsup"

import pkg from "./package.json"

export default defineConfig({
  entry: ["src/index.ts", "src/db/migrate-cli.ts"],
  // npm_package_version is unset when the image runs `node dist/index.js`, so
  // the version has to be baked in or server-info reports whatever was
  // hardcoded as the fallback.
  define: { __HEARTH_VERSION__: JSON.stringify(pkg.version) },
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
