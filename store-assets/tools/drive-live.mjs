#!/usr/bin/env node
/**
 * Streams David's drive from Work to School, one fix a second in real time,
 * the way a phone on the live tier reports while somebody watches. Starts
 * part of the way along so he is already on the move. Ctrl-C to stop.
 *
 *   node store-assets/tools/drive-live.mjs http://127.0.0.1:4100 [startFraction]
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { signIn, travel } from "./seed-demo.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const BASE = `${(process.argv[2] ?? "http://127.0.0.1:4100").replace(/\/$/, "")}/api/v1`
const startFraction = Number(process.argv[3] ?? 0.35)

const coordinates = JSON.parse(readFileSync(join(here, "routes", "work_school.json"), "utf8"))
  .routes[0].geometry.coordinates
// Laid out a second apart from now; each is sent when its moment comes.
const fixes = travel(coordinates, {
  startMs: Date.now(),
  cruiseMps: 11,
  stepSeconds: 1,
  activity: "driving",
  battery: 0.91,
})
const skip = Math.floor(fixes.length * startFraction)
const token = await signIn("david@hearth.demo")

for (let i = skip; i < fixes.length; i += 1) {
  const fix = { ...fixes[i], recordedAt: new Date().toISOString() }
  const response = await fetch(`${BASE}/locations/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ points: [fix] }),
  })
  if (!response.ok) console.error(response.status, await response.text())
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
console.log("arrived")
