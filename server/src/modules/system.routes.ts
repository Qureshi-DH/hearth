import { sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { defaultMapStyleUrl, getConfig } from "../env"
import { uptimeSeconds } from "../runtime"
import { appInviteLink, serverAddress } from "../services/invites"
import { getServerSettings } from "../services/settings"
import { storageEnabled } from "../services/storage"

declare const __HEARTH_VERSION__: string | undefined

/** Baked in by tsup for the bundle. Falls back to the package manager in dev. */
export const VERSION =
  typeof __HEARTH_VERSION__ === "string"
    ? __HEARTH_VERSION__
    : (process.env.npm_package_version ?? "0.0.0-dev")

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
          "transport to use, and which map styles to offer.",
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
        pushProvider: config.PUSH_PROVIDER,
        webPushPublicKey: config.PUSH_PROVIDER === "webpush" ? config.VAPID_PUBLIC_KEY : null,
        ntfyBaseUrl: config.PUSH_PROVIDER === "ntfy" ? config.NTFY_BASE_URL : null,
        // Apps from before the list only read these two.
        mapStyleUrl: defaultMapStyleUrl(config.mapStyles, "light"),
        mapStyleUrlDark: defaultMapStyleUrl(config.mapStyles, "dark"),
        mapStyles: config.mapStyles,
        mapAttribution: config.MAP_ATTRIBUTION,
        maxHistoryRetentionDays:
          settings.maxHistoryRetentionDays ?? config.MAX_HISTORY_RETENTION_DAYS,
        features: {
          places: true,
          history: true,
          trips: true,
          sos: true,
          checkIns: true,
          avatars: storageEnabled(),
          notificationControls: true,
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
      const deepLink = appInviteLink(code)
      const stores = [
        config.IOS_APP_URL ? { label: "Get it for iPhone", href: config.IOS_APP_URL } : null,
        config.ANDROID_APP_URL
          ? { label: "Get it for Android", href: config.ANDROID_APP_URL }
          : null,
      ].filter((store) => store !== null)
      const install =
        stores.length > 0
          ? `<span class="stores">${stores
              .map((store) => `<a href="${escapeHtml(store.href)}">${escapeHtml(store.label)}</a>`)
              .join("")}</span>`
          : " Ask whoever invited you how to get it."

      // Nothing opens the app on its own. On a phone without it, a scheme
      // nothing has claimed is an error dialog in front of the steps below.
      return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Join on ${escapeHtml(settings.serverName)}</title>
<style>
  :root { color-scheme: dark light }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:#171412; color:#F4EEE8; padding:24px; box-sizing:border-box }
  .card { max-width:24rem; width:100%; text-align:center }
  .code { font-size:2rem; font-weight:700; letter-spacing:.35em; margin:1rem 0 .25rem }
  .muted { color:#A79C91; font-size:.875rem }
  a.btn { display:block; margin-top:1.5rem; padding:.9rem 1rem; border-radius:14px;
          background:linear-gradient(135deg,#F0673B,#FF5C7A); color:#fff;
          text-decoration:none; font-weight:600 }
  h2 { font-size:1.05rem; margin:2.25rem 0 .5rem }
  ol { text-align:left; padding-left:1.25rem; margin:0 }
  li { margin:.6rem 0 }
  .stores { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem }
  .stores a { flex:1; padding:.6rem .8rem; border-radius:12px; background:#2A2420;
              color:#F4EEE8; text-decoration:none; text-align:center; font-size:.9rem }
  .address { display:block; margin-top:.5rem; padding:.6rem .8rem; border-radius:12px;
             background:#2A2420; font-family:ui-monospace, Menlo, monospace;
             font-size:.9rem; word-break:break-all; user-select:all }
</style></head><body>
<div class="card">
  <h1>Join a circle</h1>
  <p class="muted">You have been invited to a circle on ${escapeHtml(settings.serverName)}.</p>
  <div class="code">${escapeHtml(code)}</div>
  <a class="btn" href="${escapeHtml(deepLink)}">Open in Hearth</a>
  <p class="muted">If Hearth is already on this phone, that's all you need to do.</p>
  <h2>New to Hearth?</h2>
  <ol>
    <li>Install Hearth on your phone.${install}</li>
    <li>Come back to this page and tap Open in Hearth. The app fills in the server and the code.</li>
    <li>If it doesn't, open Hearth and type this server address, then create an account with the code above.
      <span class="address">${escapeHtml(serverAddress())}</span></li>
  </ol>
</div>
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
    async (request, reply) => {
      try {
        await db.execute(sql`select 1`)
        return { ok: true }
      } catch (error) {
        // The probe is unauthenticated, and a driver message names the host,
        // the role and why it was refused. Operators read it from the log.
        request.log.error({ err: error }, "readiness probe failed")
        return reply.code(503).send({ ok: false })
      }
    },
  )
}
