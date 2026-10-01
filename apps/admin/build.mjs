// Bundles the portal into dist/, which the server serves at its own address.
// No hashed file names: the whole portal is a few files the server always
// revalidates, and fixed names let a watch build replace them in place.
//
//   node build.mjs            production build
//   node build.mjs --watch    rebuild on change, for `pnpm dev` on the server
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"

import * as esbuild from "esbuild"

const watch = process.argv.includes("--watch")

rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })
cpSync("public", "dist", { recursive: true })

const options = {
  entryPoints: { portal: "src/main.tsx" },
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: ["es2022", "safari16"],
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch ? "linked" : false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
}

// The server sends the .br or .gz beside a file in its place, so a copy
// older than the file would hide the newer build. That is why dist/ is
// emptied first, and why the watch build, which rewrites files in place,
// makes no copies at all.
const COMPRESSIBLE = /\.(js|css|html|svg)$/

function precompress(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      precompress(path)
      continue
    }
    if (!COMPRESSIBLE.test(entry.name)) continue
    const source = readFileSync(path)
    writeFileSync(`${path}.gz`, gzipSync(source, { level: constants.Z_BEST_COMPRESSION }))
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
    )
  }
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
} else {
  await esbuild.build(options)
  precompress("dist")
}
