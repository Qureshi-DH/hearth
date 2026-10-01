import type { AdminCheck } from "@hearth/shared"
import { and, eq, gte, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { notificationOutbox, users } from "../db/schema"
import { getConfig, type AppConfig } from "../env"
import { getServerSettings } from "./settings"
import { storageEnabled } from "./storage"

/**
 * What the admin portal's overview lists: the parts of a setup that work on a
 * first try and bite later. Each says what it found and what to do about it.
 * Nothing here reads a position.
 */
export async function serverChecks(
  db: Database,
  config: AppConfig = getConfig(),
): Promise<AdminCheck[]> {
  const settings = await getServerSettings(db)
  const checks: AdminCheck[] = []

  checks.push(
    config.PUBLIC_URL.startsWith("https://")
      ? {
          id: "public_address",
          level: "ok",
          title: "Served over HTTPS",
          detail: `Phones reach this server at ${config.PUBLIC_URL}.`,
        }
      : {
          id: "public_address",
          level: "warning",
          title: "The public address is plain HTTP",
          detail:
            "Passwords and positions cross the network unencrypted, and a release build of " +
            "the app reaches a plain HTTP server only on the local network, or not at all on " +
            "Android. Put TLS in front and set PUBLIC_URL to the https address.",
        },
  )

  checks.push(
    settings.registrationMode === "open"
      ? {
          id: "registration",
          level: "warning",
          title: "Anyone can sign up",
          detail:
            "Whoever finds this address can create an account. Switch registration to invite " +
            "only in Settings unless you mean it.",
        }
      : {
          id: "registration",
          level: "ok",
          title:
            settings.registrationMode === "invite"
              ? "Sign-up needs an invite"
              : "Sign-up is closed",
          detail:
            settings.registrationMode === "invite"
              ? "A new account needs an invite code from a circle's admin."
              : "Nobody can create an account until registration is opened again.",
        },
  )

  const push: Record<string, Omit<AdminCheck, "id">> = {
    none: {
      level: "info",
      title: "No push notifications",
      detail:
        "Alerts, SOS included, only show on phones that have Hearth open. The push " +
        "notifications page in the docs covers the options.",
    },
    expo: {
      level: "ok",
      title: "Push through Expo",
      detail: "Works for builds made with this server's own Expo, Firebase and Apple keys.",
    },
    ntfy: {
      level: "info",
      title: "Push through ntfy",
      detail: "ntfy carries alerts, but it cannot wake the Hearth app on a phone in a pocket.",
    },
    webpush: {
      level: "warning",
      title: "Push through Web Push",
      detail: "No Hearth client uses Web Push yet, so phones get no notifications at all.",
    },
  }
  checks.push({ id: "push", ...push[config.PUSH_PROVIDER]! })

  const [{ count: admins } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true)))
  checks.push(
    admins > 1
      ? {
          id: "administrators",
          level: "ok",
          title: `${admins} administrators`,
          detail: "If one account is lost, another can still run the server.",
        }
      : {
          id: "administrators",
          level: "info",
          title: "One administrator",
          detail:
            "If this account is lost, only an edit to the database gets the server back. " +
            "Consider making a second person an administrator in Accounts.",
        },
  )

  if (config.PUSH_PROVIDER !== "none") {
    const [{ count: failed } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, "failed"),
          // A silent wake that ran out was never going to be seen, and the
          // dashboard leaves it out too.
          eq(notificationOutbox.silent, false),
          gte(notificationOutbox.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      )
    checks.push(
      failed > 0
        ? {
            id: "failed_notifications",
            level: "warning",
            title: `${failed} notification${failed === 1 ? "" : "s"} failed in the last day`,
            detail: "Notifications shows the error the push provider gave.",
          }
        : {
            id: "failed_notifications",
            level: "ok",
            title: "Notifications are going out",
            detail: "Nothing failed in the last day.",
          },
    )
  }

  checks.push(
    storageEnabled()
      ? {
          id: "storage",
          level: "ok",
          title: "Profile pictures are on",
          detail: "Pictures are kept in the configured object storage.",
        }
      : {
          id: "storage",
          level: "info",
          title: "Profile pictures are off",
          detail: "Set S3_ENDPOINT and its keys to turn them on.",
        },
  )

  if (config.ENABLE_SWAGGER && config.NODE_ENV === "production") {
    checks.push({
      id: "api_docs",
      level: "info",
      title: "The API reference is public",
      detail: "Anyone can read it at /docs. Set ENABLE_SWAGGER=false to hide it.",
    })
  }

  return checks
}
