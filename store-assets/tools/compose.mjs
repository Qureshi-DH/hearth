#!/usr/bin/env node
/**
 * Composites the raw simulator captures in raw/ into store screenshots:
 * the brand's warm ground, a two-line headline, and the capture in a phone
 * frame that bleeds off the bottom. One HTML page per shot per canvas,
 * rasterised by headless Chrome at the exact store size, then flattened to
 * RGB (both stores refuse alpha) and checked by validate.py.
 *
 *   node store-assets/tools/compose.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const repo = resolve(root, "..")
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const fonts = join(repo, "node_modules/@expo-google-fonts/space-grotesk")
const icon = join(repo, "apps/mobile/assets/images/app-icon-ios.png")
const work = join(here, ".build")

/** In story order. App Store takes all of them, Play the first eight. */
export const SHOTS = [
  {
    slug: "01-map",
    raw: "map.png",
    title: ["Everyone you love,", "on one map."],
    sub: "On your own server, where only your family can see it.",
  },
  {
    slug: "02-zero-tracking",
    raw: "server.png",
    // The one shot that argues rather than shows, so it sits second, where
    // both stores still have the reader's attention.
    compare: [
      ["Your location on their servers", "Your location on your server"],
      ["Analytics and tracking built in", "Zero tracking"],
      ["Ads, and data that can be sold", "No ads. Nothing to sell."],
      ["The company can read it", "Only your family can"],
    ],
    title: ["Other apps keep your data.", "We never see it."],
    sub: "Hearth runs on a server you own. Nothing comes to us.",
  },
  {
    slug: "03-live",
    raw: "live.png",
    // The speed card is at the bottom of the screen, and it is the point.
    whole: true,
    title: ["Follow the drive", "as it happens."],
    sub: "A new position every second, only while you are watching.",
  },
  {
    slug: "04-arrivals",
    raw: "profile.png",
    title: ["Know they", "got there."],
    sub: "Arrivals at school, work and home, without having to ask.",
  },
  {
    slug: "05-activity",
    raw: "activity.png",
    title: ["The whole day,", "at a glance."],
    sub: "Every arrival, departure and check-in in one calm feed.",
  },
  {
    slug: "06-trips",
    raw: "trip.png",
    title: ["Every trip,", "remembered."],
    sub: "Distance, time and top speed for every drive, kept on your server.",
  },
  {
    slug: "07-places",
    raw: "places.png",
    title: ["Name the places", "that matter."],
    sub: "Home, school, work. Hearth tells you when they arrive.",
  },
  {
    slug: "08-sharing",
    raw: "sharing.png",
    title: ["Share exactly", "what you want."],
    sub: "Precise, approximate or paused, separately for each circle.",
  },
  {
    slug: "09-day-and-night",
    raw: "map.png",
    pair: "map-dark.png",
    title: ["Easy on the eyes,", "day or night."],
    sub: "Light and dark themes that follow your phone.",
  },
]

/** Every canvas the stores take, and how the phone sits on each. */
export const TARGETS = [
  { dir: "app-store/screenshots/iphone-6.9-1320x2868", w: 1320, h: 2868, device: 0.87, count: 9 },
  { dir: "play/screenshots/phone-1080x1920", w: 1080, h: 1920, device: 0.8, count: 8 },
]

const fontFace = (weight, file) =>
  `@font-face{font-family:"Space Grotesk";font-weight:${weight};src:url("file://${join(fonts, file)}")}`

const CROSS = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#F1E6DE"/><path d="M8 8l8 8M16 8l-8 8" stroke="#B3A59B" stroke-width="2.4" stroke-linecap="round"/></svg>`
const CHECK = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#F0466A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function compareCard(rows) {
  const column = (cls, heading, mark, index) =>
    `<div class="col ${cls}"><h3>${heading}</h3>${rows
      .map((row) => `<div class="row">${mark}<span>${row[index]}</span></div>`)
      .join("")}</div>`
  return `<div class="card">${column("them", "Other family apps", CROSS, 0)}${column("us", "Hearth", CHECK, 1)}</div>`
}

function page(shot, target) {
  const { w, h } = target
  const u = w / 1320
  // Play's canvas is squatter, so its type and margins come down a step to
  // leave the phone room to show more than its status bar.
  const squat = h / w < 2
  const s = squat ? 0.86 : 1
  const deviceTop = Math.round((squat ? 700 : 800) * u)
  const bezel = Math.round(22 * u)
  // A whole phone fits between the headline and a bottom margin; the rest
  // bleed off the bottom edge, which hides the home indicator and reads as
  // the phone rising into the frame.
  const fitW = Math.round(((h - deviceTop - 90 * u) * 1320) / 2868 + bezel * 2)
  const deviceW = shot.whole
    ? Math.min(fitW, Math.round(w * target.device))
    : Math.round(w * (shot.pair ? 0.56 : target.device))
  const radius = Math.round(deviceW * 0.155)
  const screen = (file) => `file://${join(here, "raw", file)}`
  const phone = (file, extra = "") =>
    `<div class="device ${extra}" style="width:${deviceW}px"><img src="${screen(file)}"></div>`
  const cardH = Math.round((squat ? 560 : 720) * u)
  const devices = shot.compare
    ? compareCard(shot.compare) +
      `<div class="device" style="width:${Math.round(w * 0.72)}px;top:${deviceTop + cardH + Math.round(70 * u)}px"><img src="${screen(shot.raw)}"></div>`
    : shot.pair
      ? phone(shot.raw, "left") + phone(shot.pair, "right")
      : phone(shot.raw)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace(400, "400Regular/SpaceGrotesk_400Regular.ttf")}
${fontFace(500, "500Medium/SpaceGrotesk_500Medium.ttf")}
${fontFace(700, "700Bold/SpaceGrotesk_700Bold.ttf")}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{font-family:"Space Grotesk";background:#FBF4EC;position:relative;color:#1E1714}
.glow{position:absolute;border-radius:50%;filter:blur(${Math.round(160 * u)}px)}
.g1{width:${Math.round(900 * u)}px;height:${Math.round(900 * u)}px;left:${Math.round(-300 * u)}px;top:${Math.round(-340 * u)}px;background:#FFB48E;opacity:.75}
.g2{width:${Math.round(1000 * u)}px;height:${Math.round(1000 * u)}px;right:${Math.round(-420 * u)}px;top:${Math.round(420 * u)}px;background:#FF9BAE;opacity:.55}
.g3{width:${Math.round(800 * u)}px;height:${Math.round(800 * u)}px;left:${Math.round(-200 * u)}px;bottom:${Math.round(-300 * u)}px;background:#FFD2B8;opacity:.6}
header{position:absolute;left:0;right:0;top:${Math.round(150 * u * s)}px;text-align:center;padding:0 ${Math.round(80 * u)}px}
.brand{display:inline-flex;align-items:center;gap:${Math.round(18 * u)}px;margin-bottom:${Math.round(46 * u * s)}px}
.brand img{width:${Math.round(66 * u)}px;height:${Math.round(66 * u)}px;border-radius:${Math.round(16 * u)}px}
.brand span{font-weight:500;font-size:${Math.round(40 * u)}px;letter-spacing:${(0.2 * u).toFixed(2)}px;color:#3A2E28}
h1{font-weight:700;font-size:${Math.round(116 * u * s)}px;line-height:1.02;letter-spacing:${(-2.5 * u).toFixed(2)}px;text-wrap:balance}
h1 .accent{background:linear-gradient(95deg,#FF7A45,#F0466A);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin:${Math.round(34 * u * s)}px auto 0;max-width:${Math.round(1040 * u)}px;font-size:${Math.round(44 * u * s)}px;line-height:1.3;color:#6B6058;text-wrap:balance}
.device{position:absolute;left:50%;transform:translateX(-50%);top:${deviceTop}px;padding:${bezel}px;background:#141012;border-radius:${radius}px;box-shadow:0 ${Math.round(40 * u)}px ${Math.round(120 * u)}px rgba(120,40,20,.28),0 0 0 ${Math.round(3 * u)}px #2A2224 inset}
.device img{display:block;width:100%;border-radius:${radius - bezel}px}
.card{position:absolute;left:${Math.round(70 * u)}px;right:${Math.round(70 * u)}px;top:${deviceTop}px;height:${cardH}px;display:grid;grid-template-columns:1fr 1fr;border-radius:${Math.round(44 * u)}px;overflow:hidden;box-shadow:0 ${Math.round(30 * u)}px ${Math.round(90 * u)}px rgba(120,40,20,.18);z-index:2}
.col{display:flex;flex-direction:column;padding:${Math.round(40 * u * s)}px ${Math.round(34 * u)}px}
.them{background:#fff;color:#8A7F77}
.us{background:linear-gradient(160deg,#FF7A45,#F0466A);color:#fff}
.col h3{font-weight:700;font-size:${Math.round(40 * u * s)}px;letter-spacing:${(-0.5 * u).toFixed(2)}px;margin-bottom:${Math.round(18 * u * s)}px}
.them h3{color:#3A2E28}
.row{flex:1;display:flex;align-items:center;gap:${Math.round(18 * u)}px;font-size:${Math.round(34 * u * s)}px;line-height:1.2;font-weight:500;border-top:${Math.max(1, Math.round(2 * u))}px solid rgba(0,0,0,.06)}
.us .row{border-top-color:rgba(255,255,255,.22)}
.row svg{flex:none;width:${Math.round(44 * u * s)}px;height:${Math.round(44 * u * s)}px}
.device.left{transform:translateX(-80%) rotate(-5deg);top:${deviceTop + Math.round(60 * u)}px}
.device.right{transform:translateX(-20%) rotate(5deg);top:${deviceTop + Math.round(140 * u)}px;z-index:1}
</style></head><body>
<div class="glow g1"></div><div class="glow g2"></div><div class="glow g3"></div>
<header>
  <div class="brand"><img src="file://${icon}"><span>Hearth</span></div>
  <h1>${shot.title[0]}<br><span class="accent">${shot.title[1]}</span></h1>
  <p>${shot.sub}</p>
</header>
${devices}
</body></html>`
}

function featureGraphic() {
  const w = 1024
  const h = 500
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace(500, "500Medium/SpaceGrotesk_500Medium.ttf")}
${fontFace(700, "700Bold/SpaceGrotesk_700Bold.ttf")}
${fontFace(400, "400Regular/SpaceGrotesk_400Regular.ttf")}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{font-family:"Space Grotesk";background:linear-gradient(120deg,#FF8A5C 0%,#F5643A 45%,#F04A6A 100%);position:relative;color:#fff}
.glow{position:absolute;border-radius:50%;filter:blur(90px);background:#FFD7B0;opacity:.35;width:520px;height:520px;left:-160px;top:-260px}
.text{position:absolute;left:64px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:520px}
.brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.brand img{width:54px;height:54px;border-radius:13px;box-shadow:0 6px 18px rgba(80,10,10,.25)}
.brand span{font-weight:500;font-size:30px}
h1{font-weight:700;font-size:60px;line-height:1.02;letter-spacing:-1.5px}
p{margin-top:20px;font-size:23px;line-height:1.35;opacity:.92;max-width:470px}
.chips{display:flex;gap:10px;margin-top:22px}
.chips span{font-weight:500;font-size:17px;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.18);border:1.5px solid rgba(255,255,255,.4)}
.phone{position:absolute;right:52px;top:46px;width:300px;padding:11px;background:#141012;border-radius:48px;transform:rotate(7deg);box-shadow:0 30px 70px rgba(90,10,20,.45)}
.phone img{display:block;width:100%;border-radius:38px}
</style></head><body>
<div class="glow"></div>
<div class="text">
  <div class="brand"><img src="file://${icon}"><span>Hearth</span></div>
  <h1>Zero tracking.<br>Your server.</h1>
  <p>Other family apps keep your location on their servers. Hearth keeps it on yours.</p>
  <div class="chips"><span>No ads</span><span>Nothing sold</span><span>Open source</span></div>
</div>
<div class="phone"><img src="file://${join(here, "raw", "map.png")}"></div>
</body></html>`
}

function render(html, w, h, out) {
  const file = join(work, `${out.replace(/[/.]/g, "_")}.html`)
  writeFileSync(file, html)
  const png = join(work, "render.png")
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${w},${h}`,
      "--virtual-time-budget=4000",
      `--screenshot=${png}`,
      `file://${file}`,
    ],
    { stdio: "ignore" },
  )
  const target = join(root, out)
  mkdirSync(dirname(target), { recursive: true })
  // Chrome writes RGBA; the stores want 24-bit RGB with no alpha channel.
  execFileSync("python3", [
    "-c",
    `from PIL import Image;im=Image.open("${png}").convert("RGB");im=im.resize((${w},${h})) if im.size!=(${w},${h}) else im;im.save("${target}",optimize=True)`,
  ])
  console.log(`wrote ${out}`)
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
for (const target of TARGETS) {
  rmSync(join(root, target.dir), { recursive: true, force: true })
  for (const shot of SHOTS.slice(0, target.count)) {
    render(
      page(shot, target),
      target.w,
      target.h,
      `${target.dir}/${shot.slug}_${target.w}x${target.h}.png`,
    )
  }
}
render(featureGraphic(), 1024, 500, "play/graphics/feature-graphic_1024x500.png")
execFileSync("python3", [
  "-c",
  `from PIL import Image;Image.open("${icon}").convert("RGBA").resize((512,512),Image.LANCZOS).save("${join(root, "play/graphics/icon_512x512.png")}");Image.open("${icon}").convert("RGB").save("${join(root, "app-store/graphics/icon_1024x1024.png")}")`,
])
console.log("wrote icons")
rmSync(work, { recursive: true, force: true })
