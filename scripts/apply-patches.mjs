// Applies the patches in patches/ to the installed packages, once each.
//
// pnpm has patchedDependencies for this, and with node-linker=hoisted, which
// Metro needs, it applies a patch again on every install, so the second
// `pnpm install` (expo prebuild runs one) left the patched Kotlin declared
// twice and the build failing. This does the same job idempotently: a patch
// already in the package is left alone, a package that is not installed is
// skipped, which is the server's image, and anything else is an error.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const patchesDir = join(root, "patches")
if (!existsSync(patchesDir)) process.exit(0)

const git = (args, options = {}) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options })

// The server's image installs the workspace on a node:alpine base with no
// git. Nothing there compiles the packages these patches change, so the
// honest answer is to say so and step aside, not to report a patch that
// "does not apply".
try {
  git(["--version"])
} catch {
  console.log(
    "apply-patches: git is not available here; native patches are not needed for this install",
  )
  process.exit(0)
}

for (const file of readdirSync(patchesDir).filter((name) => name.endsWith(".patch"))) {
  // "expo-location@55.1.14.patch", or "@scope+name@1.2.3.patch" as pnpm writes it.
  const spec = file.slice(0, -".patch".length)
  const at = spec.lastIndexOf("@")
  const name = spec.slice(0, at).replace(/\+/g, "/")
  const version = spec.slice(at + 1)
  const target = join(root, "node_modules", name)
  if (!existsSync(join(target, "package.json"))) continue

  const installed = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version
  if (installed !== version) {
    console.error(
      `patches/${file} is for ${name}@${version} but ${installed} is installed. Rebase the patch.`,
    )
    process.exit(1)
  }

  const patch = join(patchesDir, file)
  const directory = join("node_modules", name)
  const applies = (extra) => {
    try {
      git(["apply", "--check", `--directory=${directory}`, ...extra, patch])
      return true
    } catch {
      return false
    }
  }
  if (applies(["--reverse"])) continue
  if (!applies([])) {
    console.error(
      `patches/${file} neither applies to nor is already in ${directory}. The package changed underneath it.`,
    )
    process.exit(1)
  }
  git(["apply", `--directory=${directory}`, patch])
  console.log(`applied patches/${file}`)
}
