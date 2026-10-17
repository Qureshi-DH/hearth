import * as Notifications from "expo-notifications"
import type { FeedEvent, PublicUser, SosAlert, WsServerMessage } from "@hearth/shared"

import { translate } from "@/i18n/translate"
import { useAuthStore } from "@/stores/auth"
import { usePushStore } from "@/stores/push"

/**
 * With no push provider, the only way a phone hears about an SOS is a frame on
 * one of its sockets, and a frame only refreshes data. This rings for the two
 * alerts nobody may sleep through, somebody else's SOS and the server's
 * possible-incident check. Either socket can carry them, the screens' own while
 * the app is open and the tracker's control channel, which an iPhone holds while
 * it shares and an Android phone while it is on the move.
 *
 * Only where push will not bring the same alert, or the phone would ring twice.
 * Its own module because the control channel is below the tracker, and the
 * screens' socket is above it.
 */

/** What has rung, to the notification it put up, oldest first. */
const rung = new Map<string, string>()
/** Each SOS alert heard, to the press it belongs to. */
const pressOf = new Map<string, string>()
const RUNG_CAP = 200

function pushWillNotArrive(): boolean {
  const provider = useAuthStore.getState().serverInfo?.pushProvider
  if (provider === "none" || provider === "webpush") return true
  // A build with no push project, or a simulator, registers nothing.
  return usePushStore.getState().setup?.kind === "unsupported"
}

export function noticeSocketAlert(message: WsServerMessage): void {
  if (message.type === "sos") void ringForSos(message.alert)
  else if (message.type === "event" && message.event.type === "possible_incident") {
    void ringForIncident(message.event)
  } else if (message.type === "event" && message.event.type === "sos_resolved") {
    void quiet(message.event)
  }
}

async function ringForSos(alert: SosAlert): Promise<void> {
  if (alert.resolvedAt || alert.user.id === useAuthStore.getState().user?.id) return
  // One press opens an alert in every circle of the raiser's, all in one
  // transaction and so with one start time. Somebody in two of those circles
  // is told once, as push tells them.
  const press = `${alert.user.id}@${alert.startedAt}`
  remember(pressOf, alert.id, press)
  await ring(press, `sos-${alert.user.id}-${Date.parse(alert.startedAt)}`, {
    title: translate("notifications:sosAlertTitle", { name: nameOf(alert.user) }),
    body: oneLine(alert.note ?? "") || translate("notifications:sosAlertBody"),
    data: { type: "sos_started", alertId: alert.id, circleId: alert.circleId },
  })
}

async function ringForIncident(event: FeedEvent): Promise<void> {
  if (event.actor?.id === useAuthStore.getState().user?.id) return
  await ring(event.id, `incident-${event.id}`, {
    title: translate("incident:checkOnTitle", { name: nameOf(event.actor) }),
    body: event.summary,
    data: {
      type: "possible_incident",
      circleId: event.circleId,
      eventId: event.id,
      ...(event.actor ? { userId: event.actor.id } : {}),
    },
  })
}

/**
 * Only when every alert of that press this phone heard about is resolved. An
 * admin closes one in their own circle and leaves the rest open.
 */
async function quiet(event: FeedEvent): Promise<void> {
  const alertId = event.payload.alertId
  const press = typeof alertId === "string" ? pressOf.get(alertId) : undefined
  if (!press) return
  pressOf.delete(alertId as string)
  if ([...pressOf.values()].includes(press)) return
  const identifier = rung.get(press)
  if (!identifier) return
  try {
    await Notifications.dismissNotificationAsync(identifier)
  } catch {
    // Already swiped away.
  }
}

async function ring(
  key: string,
  identifier: string,
  content: { title: string; body: string; data: Record<string, unknown> },
): Promise<void> {
  if (rung.has(key) || !pushWillNotArrive()) return
  remember(rung, key, identifier)
  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        ...content,
        sound: "default",
        interruptionLevel: "timeSensitive",
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      // The channel is read from the trigger, and the SOS channel is the one
      // allowed through Do Not Disturb.
      trigger: { channelId: "sos" },
    })
  } catch {
    // Notifications are off for Hearth. The map's banner still shows it.
  }
}

function remember(map: Map<string, string>, key: string, value: string): void {
  map.set(key, value)
  if (map.size > RUNG_CAP) map.delete(map.keys().next().value!)
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const nameOf = (user: PublicUser | null): string =>
  (user && oneLine(user.displayName)) || translate("notifications:someone")
