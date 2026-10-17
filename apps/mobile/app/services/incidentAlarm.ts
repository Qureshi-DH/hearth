import { AppState, Platform } from "react-native"
import * as Notifications from "expo-notifications"
import type { Circle, DriveEvent } from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { translate } from "@/i18n/translate"
import { ApiError, endpoints } from "@/services/api"
import { logTracker } from "@/services/location/log"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { useIncidentStore, type IncidentNotice, type PendingIncident } from "@/stores/incident"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "@/stores/toast"
import { tokenVault } from "@/stores/tokenVault"

/**
 * Everything that happens to a possible crash after the detector reports it,
 * which is the question, the lock screen alarm, the decision and the SOS it
 * turns into. A plain module rather than the prompt's own state, because the
 * prompt only exists while the app is in front, and a phone that has just been
 * through a collision is usually locked in a footwell.
 *
 * Nothing in here waits on a timer. Timers stand still on a locked phone, so
 * every decision is taken on the wall clock at the next moment anything runs.
 * That is a fix arriving, an upload, the sync task, the notification's button,
 * the app coming to the front, or the prompt's own tick while it is on screen.
 */

/** Long enough to reach a phone after a shock, short enough to still matter. */
export const INCIDENT_COUNTDOWN_MS = 30_000
/**
 * Beyond this the phone can no longer vouch for where the person is. They may
 * have walked away, been driven off, or the process may only now be coming back
 * from a restart. Raising an SOS on a location from a different quarter of an
 * hour would send help to the wrong place, so past here it stops being
 * automatic and goes back to being their decision. An alert already decided on
 * before this line is not affected. It only lacked a signal.
 */
export const INCIDENT_STALE_MS = 5 * 60_000
/**
 * And past this it is not a question worth asking. The incident survives a
 * restart on purpose, but a phone that comes back long afterwards should not
 * open on "are you okay?" about something the person plainly walked away from.
 */
export const INCIDENT_FORGET_MS = 60 * 60_000
/**
 * Between attempts at an alert that could not go out. A phone with no signal
 * may be taking a fix a second, and each one would otherwise be a request. An
 * upload that gets through skips the wait after a network failure, since it
 * proves the server can be reached. Not after a 429 or a 5xx, which Hearth
 * itself answered, and asking again a second later is what a 429 refuses.
 */
const RETRY_AFTER_MS = [15_000, 30_000, 60_000, 120_000]

export const INCIDENT_NOTIFICATION_ID = "hearth-incident"
const INCIDENT_CATEGORY = "hearth-incident"
export const INCIDENT_OK_ACTION = "incident-ok"

export type IncidentPhase = "none" | "asking" | "due" | "stale" | "sending" | "forget"

export function incidentPhase(pending: PendingIncident | null, now: number): IncidentPhase {
  if (!pending) return "none"
  const age = now - pending.detectedAt
  if (age > INCIDENT_FORGET_MS) return "forget"
  if (pending.escalatedAt != null) return "sending"
  if (age > INCIDENT_STALE_MS) return "stale"
  if (age >= INCIDENT_COUNTDOWN_MS) return "due"
  return "asking"
}

export const incidentDeadline = (pending: PendingIncident): number =>
  pending.detectedAt + INCIDENT_COUNTDOWN_MS

export async function raiseIncident(
  event: Extract<DriveEvent, { kind: "possibleImpact" }>,
): Promise<void> {
  useIncidentStore.getState().raise(event, useAuthStore.getState().user?.id ?? null)
  logTracker("incident", { step: "raised" })
  await checkIncident()
}

let sending: Promise<void> | null = null

/**
 * Safe to call as often as anything likes. Each call decides from the clock
 * what the incident needs now, and most of the time that is nothing.
 */
export function checkIncident({ online = false }: { online?: boolean } = {}): Promise<void> {
  if (sending) return sending
  const pending = useIncidentStore.getState().pending
  if (!pending) return Promise.resolve()
  const owner = useAuthStore.getState().user?.id
  if (pending.userId && owner && owner !== pending.userId) return finish("other account")
  const now = Date.now()
  switch (incidentPhase(pending, now)) {
    case "forget":
      return finish("forgotten")
    case "asking":
      return showNotice("countdown")
    case "stale":
      return showNotice("stale")
    case "due":
      useIncidentStore.getState().update({ escalatedAt: now })
      return send()
    case "sending":
      return (online && pending.failure === "network") || retryDue(pending, now)
        ? send()
        : showNotice("waiting")
    default:
      return Promise.resolve()
  }
}

/** "Alert my circle now", which is also the only way out of the stale state. */
export function escalateIncident(): Promise<void> {
  const pending = useIncidentStore.getState().pending
  if (!pending) return Promise.resolve()
  if (pending.escalatedAt == null) useIncidentStore.getState().update({ escalatedAt: Date.now() })
  return sending ?? send()
}

/** "I'm okay", from the prompt or the notification. */
export function dismissIncident(): Promise<void> {
  return finish("dismissed")
}

/**
 * A response to the incident's notification, from the app's listener or from
 * Android's notification task, which runs for the button without the app
 * coming up. Says whether it was ours, so the caller leaves it alone.
 */
export async function answerIncidentResponse(payload: unknown): Promise<boolean> {
  const response = payload as
    | {
        actionIdentifier?: string
        notification?: {
          request?: {
            identifier?: string
            content?: { data?: { type?: unknown; detectedAt?: unknown } | null }
          }
        }
      }
    | null
    | undefined
  const request = response?.notification?.request
  const ours =
    request?.identifier === INCIDENT_NOTIFICATION_ID || request?.content?.data?.type === "incident"
  if (!ours) return false
  // Android keeps the last response and hands it back to an app opened hours
  // later, so an answer counts only for the incident it was given about, and
  // is forgotten once it has been.
  try {
    Notifications.clearLastNotificationResponse()
  } catch {
    // An older runtime without it. The incident check below still holds.
  }
  // Tapping the notification itself opens the app, where the prompt is already up.
  if (response?.actionIdentifier !== INCIDENT_OK_ACTION) return true
  const pending = useIncidentStore.getState().pending
  const about = Number(request?.content?.data?.detectedAt)
  if (pending && about === pending.detectedAt) await dismissIncident()
  return true
}

function retryDue(pending: PendingIncident, now: number): boolean {
  if (pending.triedAt == null) return true
  const step = Math.min(Math.max((pending.attempts ?? 1) - 1, 0), RETRY_AFTER_MS.length - 1)
  return now - pending.triedAt >= RETRY_AFTER_MS[step]!
}

function send(): Promise<void> {
  sending = attempt().finally(() => {
    sending = null
  })
  return sending
}

async function attempt(): Promise<void> {
  const pending = useIncidentStore.getState().pending
  if (!pending?.escalatedAt) return
  // Without a session the request goes out unauthenticated and is answered
  // 401, and a firewall in front of the server locks the phone out for that.
  if (!useAuthStore.getState().serverUrl || !(await tokenVault.hydrate())) {
    await showNotice("waiting")
    return
  }
  const first = !pending.attempts
  useIncidentStore.getState().update({ triedAt: Date.now(), attempts: (pending.attempts ?? 0) + 1 })
  // A fresh fix first, so the alert carries where they actually are. Only the
  // first time, since after that the tracker's own fixes keep coming, and its
  // queue uploads them ahead of the retry that follows a successful upload.
  if (first) await freshFix()

  try {
    const circleId = await incidentCircle()
    if (!circleId) {
      await finish("no circle")
      return
    }
    // The fix can take half a minute and the lookup a round trip, and "I'm
    // okay" may have been the answer in the meantime.
    if (useIncidentStore.getState().pending?.detectedAt !== pending.detectedAt) return
    await endpoints.safety.raiseSos(circleId, translate("incident:autoNote"), "incident")
  } catch (error) {
    // An older server answers 409 for a circle where this person already has
    // an alert open, and that circle has been told.
    if (!(error instanceof ApiError && error.status === 409)) {
      if (retryable(error)) {
        const unreached = !(error instanceof ApiError) || error.isNetwork || error.isForeign
        useIncidentStore.getState().update({ failure: unreached ? "network" : "server" })
        logTracker("incident", {
          step: "send failed",
          status:
            error instanceof ApiError ? (error.isNetwork ? "network" : error.status) : "error",
        })
        await showNotice("waiting")
        return
      }
      toast.error((error as Error).message)
      await finish("refused")
      return
    }
  }
  toast.success(translate("incident:raised"))
  void queryClient.invalidateQueries({ queryKey: ["sos"] })
  await finish("sent")
  // Its upload reply carries the alert's live window, to a phone lying still
  // with no control channel open to hear it on.
  void freshFix()
}

/**
 * Required when it is needed rather than imported. The tracker imports this
 * module to raise an incident, and a cycle between the two, resolved while the
 * app loads, can hand one of them a module that is not there yet.
 */
async function freshFix(): Promise<void> {
  try {
    const tracker =
      require("@/services/location/tracker") as typeof import("@/services/location/tracker")
    await tracker.reportNow("sos")
  } catch {
    // No fix is no reason to hold the alert back. The server has the last one.
  }
}

/**
 * Only what can change with time is tried again. Anything else Hearth refused
 * will be refused the same way, and asking again into a firewall that blocks
 * on a 4xx takes the whole household offline.
 */
function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  if (error.isNetwork || error.isForeign || error.status >= 500 || error.status === 429) return true
  // The client refreshes on a 401 before this sees one. Tokens still held mean
  // the refresh got no answer, not that the session is over.
  return error.status === 401 && tokenVault.peek() != null
}

/**
 * A circle that asked for incident alerts. The server raises it in every one
 * of the person's circles that did, so this only picks the door, preferring
 * the circle on screen. The cache is cold in a process the OS started for a
 * fix, so the server is asked then.
 */
async function incidentCircle(): Promise<string | null> {
  const cached = queryClient.getQueryData<Circle[]>(queryKeys.circles)
  const circles = cached?.some((circle) => circle.settings.incidentDetection)
    ? cached
    : await endpoints.circles.list()
  const asked = circles.filter((circle) => circle.settings.incidentDetection)
  const active = useSettingsStore.getState().activeCircleId
  return (asked.find((circle) => circle.id === active) ?? asked[0])?.id ?? null
}

// Signing out, by hand, by the session expiring or by a change of server,
// leaves nothing that could send the alert, and a notice saying it is waiting
// for a connection would be a lie.
useAuthStore.subscribe((state, previous) => {
  if (previous.user && !state.user) void finish("signed out")
})

async function finish(outcome: string): Promise<void> {
  if (useIncidentStore.getState().pending) logTracker("incident", { step: outcome })
  useIncidentStore.getState().clear()
  try {
    await Notifications.dismissNotificationAsync(INCIDENT_NOTIFICATION_ID)
  } catch {
    // Nothing was posted, or notifications are off. Either way nothing stays.
  }
}

/**
 * Android runs the notification task for a button without bringing the app
 * up, so "I'm okay" is answered from the lock screen. iOS only tells an app
 * that is still running, and a killed one would never hear it and send the
 * alert anyway, so there the button opens Hearth. Set before every notice,
 * since a process the OS started for a fix has never set it.
 */
async function ensureCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(INCIDENT_CATEGORY, [
    {
      identifier: INCIDENT_OK_ACTION,
      buttonTitle: translate("incident:imOk"),
      options: { opensAppToForeground: Platform.OS !== "android" },
    },
  ])
}

/**
 * The phone may be face down in a footwell, and a prompt nobody is looking at
 * is not an alarm. So whenever the app is not in front the incident is on the
 * lock screen as well, on the SOS channel, and the notification always says
 * what is about to happen. It goes when the incident does, whichever way.
 */
async function showNotice(kind: IncidentNotice): Promise<void> {
  const pending = useIncidentStore.getState().pending
  if (!pending || pending.notice === kind) return
  // In front, the prompt is the alarm. One already posted is still kept true.
  if (AppState.currentState === "active" && !pending.notice) return
  useIncidentStore.getState().update({ notice: kind })
  // An answer can land during either await, and a notice posted after it
  // would stand with no incident behind it.
  const current = () => useIncidentStore.getState().pending?.detectedAt === pending.detectedAt
  try {
    await ensureCategory()
    if (!current()) return
    await Notifications.scheduleNotificationAsync({
      identifier: INCIDENT_NOTIFICATION_ID,
      content: {
        title: translate("incident:alarmTitle"),
        body:
          kind === "countdown"
            ? translate("incident:alarmBody", { time: clock(incidentDeadline(pending)) })
            : kind === "waiting"
              ? translate("incident:alarmWaiting")
              : translate("incident:alarmStale"),
        sound: "default",
        data: { type: "incident", detectedAt: pending.detectedAt },
        categoryIdentifier: INCIDENT_CATEGORY,
        interruptionLevel: "timeSensitive",
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      // On the trigger, which is where Android reads the channel from.
      trigger: { channelId: "sos" },
    })
    if (!current()) await Notifications.dismissNotificationAsync(INCIDENT_NOTIFICATION_ID)
  } catch (error) {
    // Notifications refused, most likely. The prompt is still there.
    logTracker("incident", { step: "notice failed", error: (error as Error).message })
  }
}

/** Seconds included, because the whole countdown fits inside one minute. */
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
