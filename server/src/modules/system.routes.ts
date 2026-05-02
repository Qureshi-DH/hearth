import { sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { users } from "../db/schema"
import { getConfig } from "../env"
import { uptimeSeconds } from "../runtime"
import { getServerSettings } from "../services/settings"

const VERSION = process.env.npm_package_version ?? "0.1.0"

/**
 * The app has no way to know that the very first account skips the invite
 * gate, so it has to be told. Latches once somebody registers, because
 * server-info is the first call every launch makes and an unclaimed server
 * is the only case that needs the query.
 */
let serverClaimed = false

async function setupRequired(db: ReturnType<typeof getDb>): Promise<boolean> {
  if (serverClaimed) return false
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
  serverClaimed = count > 0
  return !serverClaimed
}

export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/server-info",
    {
      schema: {
        tags: ["system"],
        summary: "Public server capabilities",
        description:
          "The first call the app makes against a new server URL. It carries everything the " +
          "client needs to configure itself: whether registration is open, which push " +
          "transport to use, and which map style to render.",
      },
    },
    async () => {
      const config = getConfig()
      const settings = await getServerSettings(db)

      return {
        serverName: settings.serverName,
        version: VERSION,
        apiVersion: "v1",
        registrationMode: settings.registrationMode,
        setupRequired: await setupRequired(db),
        pushProvider: config.PUSH_PROVIDER,
        webPushPublicKey: config.PUSH_PROVIDER === "webpush" ? config.VAPID_PUBLIC_KEY : null,
        ntfyBaseUrl: config.PUSH_PROVIDER === "ntfy" ? config.NTFY_BASE_URL : null,
        mapStyleUrl: config.MAP_STYLE_URL,
        mapStyleUrlDark: config.MAP_STYLE_URL_DARK || config.MAP_STYLE_URL,
        mapAttribution: config.MAP_ATTRIBUTION,
        features: {
          places: true,
          history: true,
          trips: true,
          sos: true,
          checkIns: true,
        },
      }
    },
  )
}

/**
 * `inviteUrl()` hands out `${PUBLIC_URL}/join/<code>` and people paste those
 * into messages, so a browser needs somewhere to land.
 */
export const joinRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/join/:code",
    {
      schema: {
        tags: ["system"],
        summary: "Invite landing page (opens the app)",
        params: z.object({ code: z.string().trim().min(4).max(16) }),
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const config = getConfig()
      const settings = await getServerSettings(db)
      const code = request.params.code.toUpperCase().replace(/[^A-Z0-9]/g, "")
      const deepLink = `${config.APP_SCHEME}://join/${code}`

      return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join on ${escapeHtml(settings.serverName)}</title>
<style>
  :root { color-scheme: dark light }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:#171412; color:#F4EEE8; padding:24px }
  .card { max-width:22rem; text-align:center }
  .code { font-size:2rem; font-weight:700; letter-spacing:.35em; margin:1rem 0 .25rem }
  .muted { color:#A79C91; font-size:.875rem }
  a.btn { display:block; margin-top:1.5rem; padding:.9rem 1rem; border-radius:14px;
          background:linear-gradient(135deg,#F0673B,#FF5C7A); color:#fff;
          text-decoration:none; font-weight:600 }
</style></head><body>
<div class="card">
  <h1>Join a circle</h1>
  <p class="muted">You have been invited to a circle on ${escapeHtml(settings.serverName)}.</p>
  <div class="code">${escapeHtml(code)}</div>
  <p class="muted">Open Hearth and enter this code, or tap below if the app is installed.</p>
  <a class="btn" href="${escapeHtml(deepLink)}">Open in Hearth</a>
  <p class="muted" style="margin-top:1.5rem">Server address: ${escapeHtml(config.PUBLIC_URL)}</p>
</div>
<script>setTimeout(function(){ location.href = ${JSON.stringify(deepLink)} }, 400)</script>
</body></html>`)
    },
  )
}

/** Every value interpolated into the page above is operator- or user-supplied. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Registered outside the versioned API prefix, so probe URLs never move. */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/healthz",
    { schema: { tags: ["system"], summary: "Liveness probe" }, logLevel: "warn" },
    async () => ({ ok: true, uptimeSeconds: uptimeSeconds() }),
  )

  app.get(
    "/readyz",
    {
      schema: { tags: ["system"], summary: "Readiness probe (checks the database)" },
      logLevel: "warn",
    },
    async (_request, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { ok: true }
      } catch (error) {
        return reply.code(503).send({ ok: false, error: (error as Error).message })
      }
    },
  )
}
