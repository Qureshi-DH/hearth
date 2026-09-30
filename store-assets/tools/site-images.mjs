#!/usr/bin/env node
/**
 * The pictures on the landing page in web/: every raw capture as WebP at the
 * two widths the page asks for, and the card a link preview shows. Framing
 * is left to the page's CSS, so a phone looks the same in either theme and
 * the images stay plain screenshots.
 *
 *   node store-assets/tools/site-images.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../..")
const web = join(repo, "web")
const out = join(web, "screens")
const work = join(here, ".build-site")
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const raw = (name) => join(here, "raw", `${name}.png`)

const SCREENS = [
  "map",
  "map-dark",
  "focus",
  "live",
  "profile-driving",
  "profile",
  "trip",
  "places",
  "activity",
  "quick-message",
  "save-place",
  "sharing",
  "server",
]

// 440 fills a gallery tile at twice its CSS size, 880 the lightbox and the
// hero's middle phone on a sharp screen. Nothing on the page wants more.
const WIDTHS = [440, 880]

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const name of SCREENS) {
  for (const width of WIDTHS) {
    execFileSync("cwebp", [
      "-quiet",
      "-q",
      "80",
      "-resize",
      String(width),
      "0",
      raw(name),
      "-o",
      join(out, `${name}-${width}.webp`),
    ])
  }
  console.log(`wrote web/screens/${name}-{${WIDTHS.join(",")}}.webp`)
}

// The link preview card. Social sites want a plain JPEG or PNG at 1200x630
// and no transparency, so it is laid out in Chrome and flattened with Pillow.
const phone = (name, width, extra = "") => {
  const bezel = Math.round(width * 0.028)
  const radius = Math.round(width * 0.155)
  return `<div class="phone ${extra}" style="width:${width}px;padding:${bezel}px;border-radius:${radius}px">
    <img src="file://${raw(name)}" style="border-radius:${radius - bezel}px"></div>`
}

const card = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1200px;height:630px;overflow:hidden;background:#fbf7f2}
body{position:relative;font-family:"Space Grotesk","Helvetica Neue",Arial,sans-serif;color:#1e1714}
.glow{position:absolute;right:-120px;top:-60px;width:820px;height:820px;border-radius:50%;
  background:radial-gradient(closest-side,rgba(255,138,92,.34),rgba(240,74,106,.12) 60%,transparent)}
.copy{position:absolute;left:72px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center}
.brand{display:flex;align-items:center;gap:16px;font-weight:700;font-size:34px;letter-spacing:-.03em}
.mark{width:52px;height:52px;border-radius:16px;background:linear-gradient(140deg,#ff8a5c,#f04a6a);display:grid;place-items:center}
.mark svg{width:31px;height:31px;fill:#fff}
h1{margin-top:34px;font-size:60px;line-height:1.04;letter-spacing:-.03em;font-weight:700}
h1 em{font-style:normal;background:linear-gradient(100deg,#f5643a,#f04a6a);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin-top:22px;font-size:24px;color:#6b6058;letter-spacing:-.01em}
.row{position:absolute;right:40px;top:58px;display:flex;align-items:flex-start;gap:0}
.phone{background:#141012;box-shadow:0 22px 44px rgba(40,20,10,.26),0 0 0 3px #2A2224 inset;flex:none}
.phone img{display:block;width:100%}
.back{margin-top:44px}
.left{margin-right:-34px;transform:rotate(-5deg)}
.right{margin-left:-34px;transform:rotate(5deg)}
.front{position:relative;z-index:1}
</style></head><body>
<div class="glow"></div>
<div class="copy">
  <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill-rule="evenodd"><path d="M12 2c.6 3.2-1.2 4.6-2.6 6C7.6 9.6 6 11.3 6 14a6 6 0 0 0 12 0c0-2.5-1.2-4.3-2.6-6C13.7 6 12.6 4.4 12 2Zm0 8.6c1.2 1.4 2 2.4 2 3.6a2 2 0 1 1-4 0c0-1.2.8-2.2 2-3.6Z"/></svg></span>Hearth</div>
  <h1>Know where your family is. <em>Nobody else does.</em></h1>
  <p>Family location sharing you host yourself.</p>
</div>
<div class="row">
  ${phone("live", 200, "back left")}
  ${phone("map", 240, "front")}
  ${phone("profile-driving", 200, "back right")}
</div>
</body></html>`

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const html = join(work, "card.html")
const png = join(work, "card.png")
writeFileSync(html, card)
execFileSync(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1200,630",
    "--virtual-time-budget=4000",
    `--screenshot=${png}`,
    `file://${html}`,
  ],
  { stdio: "ignore" },
)
execFileSync("python3", [
  "-c",
  `from PIL import Image;Image.open("${png}").convert("RGB").save("${join(web, "og.jpg")}",quality=86,optimize=True,progressive=True)`,
])
console.log("wrote web/og.jpg")
rmSync(work, { recursive: true, force: true })
