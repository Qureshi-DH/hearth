#!/usr/bin/env node
/**
 * Gives every demo member other than Sarah a fix from right now, at the spot
 * they are already at, so nobody reads as stale ("faded") in a capture.
 * Run it just before each screenshot session.
 *
 *   node store-assets/tools/refresh-demo.mjs http://127.0.0.1:4100
 */
import { PLACES, signIn } from "./seed-demo.mjs"

const BASE = `${(process.argv[2] ?? "http://127.0.0.1:4100").replace(/\/$/, "")}/api/v1`

const SPOTS = {
  "david@hearth.demo": { ...PLACES.work, battery: 0.93 },
  "maya@hearth.demo": { ...PLACES.school, battery: 0.68 },
  "leo@hearth.demo": { lat: 37.7596, lon: -122.4269, battery: 0.37 },
  "rosa@hearth.demo": { ...PLACES.grandma, battery: 0.86, charging: true },
}

for (const [email, spot] of Object.entries(SPOTS)) {
  const token = await signIn(email)
  const response = await fetch(`${BASE}/locations/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      points: [
        {
          recordedAt: new Date().toISOString(),
          lat: spot.lat + 0.00003,
          lon: spot.lon - 0.00002,
          accuracyMeters: 9,
          speedMps: 0,
          activity: "still",
          batteryLevel: spot.battery,
          isCharging: Boolean(spot.charging),
          source: "background",
        },
      ],
    }),
  })
  if (!response.ok) throw new Error(`${email}: ${response.status} ${await response.text()}`)
}
console.log("refreshed")
