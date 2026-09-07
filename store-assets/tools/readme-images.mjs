#!/usr/bin/env node
/**
 * The pictures in the repository README: the logo, a hero of five phones and
 * a small gallery, framed from the same raw captures as the store
 * screenshots. Transparent, so they sit on GitHub's light and dark themes
 * alike, and WebP, so the README stays light.
 *
 *   node store-assets/tools/readme-images.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../..")
const out = join(repo, ".github/assets")
const work = join(here, ".build-readme")
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const icon = join(repo, "apps/mobile/assets/images/app-icon-ios.png")
const raw = (name) => `file://${join(here, "raw", name)}`

const phone = (file, width, extra = "") => {
  const bezel = Math.round(width * 0.028)
  const radius = Math.round(width * 0.155)
  return `<div class="phone ${extra}" style="width:${width}px;padding:${bezel}px;border-radius:${radius}px">
    <img src="${raw(file)}" style="border-radius:${radius - bezel}px"></div>`
}

const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:transparent}
.row{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:${Math.round(w * 0.018)}px}
.phone{background:#141012;box-shadow:0 16px 32px rgba(40,20,10,.22),0 0 0 3px #2A2224 inset;flex:none}
.phone img{display:block;width:100%}
.lift{transform:translateY(-4%)}
</style></head><body>${body}</body></html>`

function render(name, w, h, html) {
  const file = join(work, `${name}.html`)
  const png = join(work, `${name}.png`)
  writeFileSync(file, html)
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${w},${h}`,
      "--virtual-time-budget=4000",
      `--screenshot=${png}`,
      `file://${file}`,
    ],
    { stdio: "ignore" },
  )
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    "82",
    "-alpha_q",
    "100",
    png,
    "-o",
    join(out, `${name}.webp`),
  ])
  console.log(`wrote .github/assets/${name}.webp`)
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(out, { recursive: true })

// The map in the middle, the day's story either side of it.
const hero = (map) =>
  page(
    2000,
    1120,
    `<div class="row">
    ${phone("activity.png", 330)}
    ${phone("profile.png", 360, "lift")}
    ${phone(map, 420, "lift")}
    ${phone("live.png", 360, "lift")}
    ${phone("trip.png", 330)}
  </div>`,
  )
render("hero-light", 2000, 1120, hero("map.png"))
render("hero-dark", 2000, 1120, hero("map-dark.png"))

for (const [name, file] of [
  ["places", "places.png"],
  ["sos", "focus.png"],
  ["sharing", "sharing.png"],
]) {
  render(`screen-${name}`, 540, 1100, page(540, 1100, `<div class="row">${phone(file, 440)}</div>`))
}

// The app icon with the corners iOS would give it.
render(
  "logo",
  240,
  240,
  `<!doctype html><html><head><style>
html,body{margin:0;width:240px;height:240px;background:transparent}
img{width:240px;height:240px;border-radius:54px;display:block}
</style></head><body><img src="file://${icon}"></body></html>`,
)

rmSync(work, { recursive: true, force: true })
