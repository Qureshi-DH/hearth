import { AppState, Platform } from "react-native"
import type { Circle, DriveEvent } from "@hearth/shared"

import { queryKeys } from "@/hooks/queryKeys"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"
import { useIncidentStore } from "@/stores/incident"
import { useSettingsStore } from "@/stores/settings"

import {
  INCIDENT_COUNTDOWN_MS,
  INCIDENT_NOTIFICATION_ID,
  INCIDENT_OK_ACTION,
  answerIncidentResponse,
  checkIncident,
  dismissIncident,
  escalateIncident,
  noteIncidentFix,
  raiseIncident,
} from "./incidentAlarm"

const mockSchedule = jest.fn(async (..._args: unknown[]) => "id")
const mockDismiss = jest.fn(async (..._args: unknown[]) => {})
const mockCategory = jest.fn(async (..._args: unknown[]) => null)
const mockClearLast = jest.fn()
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
  dismissNotificationAsync: (...args: unknown[]) => mockDismiss(...args),
  setNotificationCategoryAsync: (...args: unknown[]) => mockCategory(...args),
  clearLastNotificationResponse: () => mockClearLast(),
  AndroidNotificationPriority: { MAX: "max" },
}))

const mockRaiseSos = jest.fn()
const mockCircles = jest.fn()
jest.mock("@/services/api", () => ({
  ApiError: jest.requireActual("@/services/api/client").ApiError,
  endpoints: {
    safety: { raiseSos: (...args: unknown[]) => mockRaiseSos(...args) },
    circles: { list: () => mockCircles() },
  },
}))
let mockTokens: object | null = { accessToken: "a", refreshToken: "r" }
jest.mock("@/stores/tokenVault", () => ({
  tokenVault: { hydrate: async () => mockTokens, peek: () => mockTokens },
}))
jest.mock("@/services/location/log", () => ({ logTracker: jest.fn() }))
jest.mock("@/i18n/translate", () => ({
  translate: (key: string, params?: object) => (params ? `${key} ${JSON.stringify(params)}` : key),
}))

const { ApiError } = jest.requireActual("@/services/api/client")

const START = Date.parse("2026-03-01T08:00:00.000Z")
const mockReport = jest.fn(async (..._args: unknown[]) => null)
jest.mock("@/services/location/tracker", () => ({
  reportNow: (...args: unknown[]) => mockReport(...args),
}))

function circle(id: string, incidentDetection: boolean): Circle {
  return { id, settings: { incidentDetection } } as unknown as Circle
}

const impact = (at = Date.now()): Extract<DriveEvent, { kind: "possibleImpact" }> => ({
  kind: "possibleImpact",
  at,
  peakDeltaG: 9,
  rotationRps: 7,
  pressureJumpHpa: null,
  speedDropMps: null,
  corroborations: 2,
  speedBeforeMps: 20,
  speedBeforeAgeMs: 2000,
})

/** Moves the wall clock without running a single timer, as a locked phone does. */
const later = (ms: number) => jest.setSystemTime(Date.now() + ms)

/** What the incident's notification carried, as a response to it would. */
const okFor = (call = 0) => {
  const [request] = mockSchedule.mock.calls[call] as [Record<string, any>]
  return {
    actionIdentifier: INCIDENT_OK_ACTION,
    notification: { request: { identifier: request.identifier, content: request.content } },
  }
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets the awaits inside a send settle. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const os = Platform.OS

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(START)
  jest.clearAllMocks()
  mockTokens = { accessToken: "a", refreshToken: "r" }
  mockRaiseSos.mockResolvedValue({ id: "alert-1" })
  mockCircles.mockResolvedValue([circle("c1", true)])
  queryClient.clear()
  useIncidentStore.setState({ pending: null })
  useSettingsStore.setState({ activeCircleId: "c1", incidentDetection: true })
  useAuthStore.setState({ serverUrl: "https://hearth.test", user: { id: "me" } as never })
  ;(AppState as { currentState: string }).currentState = "background"
  Platform.OS = "android"
})

afterEach(() => {
  ;(AppState as { currentState: string }).currentState = "active"
  Platform.OS = os
  jest.useRealTimers()
})

describe("raising an incident", () => {
  it("puts a countdown on the lock screen that says when it will send", async () => {
    await raiseIncident(impact())

    expect(mockCategory).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        identifier: INCIDENT_OK_ACTION,
        // Android runs the notification task for an action without opening
        // the app, so I'm okay can be answered from the lock screen.
        options: expect.objectContaining({ opensAppToForeground: false }),
      }),
    ])
    const [request] = mockSchedule.mock.calls[0] as [Record<string, any>]
    expect(request.identifier).toBe(INCIDENT_NOTIFICATION_ID)
    // The channel goes on the trigger. On the content it is ignored, and the
    // alarm lands on the fallback channel, which Do Not Disturb silences.
    expect(request.trigger).toEqual({ channelId: "sos" })
    expect(request.content.categoryIdentifier).toBeDefined()
    expect(request.content.interruptionLevel).toBe("timeSensitive")
    expect(request.content.priority).toBe("max")
    const deadline = new Date(START + INCIDENT_COUNTDOWN_MS).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    expect(request.content.body).toContain(deadline)
  })

  it("opens the app for I'm okay on an iPhone, where a killed app never hears the answer", async () => {
    Platform.OS = "ios"
    await raiseIncident(impact())

    const [, actions] = mockCategory.mock.calls[0] as [string, Array<Record<string, any>>]
    expect(actions[0]!.options.opensAppToForeground).toBe(true)
  })

  it("leaves the notification to the prompt while the app is in front", async () => {
    ;(AppState as { currentState: string }).currentState = "active"
    await raiseIncident(impact())

    expect(mockSchedule).not.toHaveBeenCalled()
    expect(useIncidentStore.getState().pending).not.toBeNull()
  })
})

describe("escalating on the wall clock", () => {
  it("sends the alert at the first moment the app runs after the countdown, with no timer", async () => {
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 10_000)
    await checkIncident()
    await settle()

    expect(mockReport).toHaveBeenCalledWith("sos")
    expect(mockRaiseSos).toHaveBeenCalledWith("c1", expect.any(String), "incident")
    expect(mockReport.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRaiseSos.mock.invocationCallOrder[0]!,
    )
    expect(useIncidentStore.getState().pending).toBeNull()
    // Sent, so nothing is left standing on the phone.
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
  })

  it("reports once more once it has gone, so the upload reply puts the phone on Live", async () => {
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 10_000)
    await checkIncident()
    await settle()

    expect(mockReport).toHaveBeenCalledTimes(2)
    expect(mockReport.mock.invocationCallOrder[1]!).toBeGreaterThan(
      mockRaiseSos.mock.invocationCallOrder[0]!,
    )
  })

  it("does nothing while the countdown still runs", async () => {
    await raiseIncident(impact())
    later(20_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).not.toHaveBeenCalled()
  })

  it("keeps an alert that found no signal, and sends it when the connection is back", async () => {
    mockRaiseSos.mockRejectedValueOnce(new ApiError(0, "network_error", "offline"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).toHaveBeenCalledTimes(1)
    const pending = useIncidentStore.getState().pending
    expect(pending?.escalatedAt).toBeDefined()
    expect(pending?.escalatedAt).not.toBeNull()
    // The lock screen says it is still trying, rather than a countdown that ran out.
    const last = mockSchedule.mock.calls.at(-1) as [Record<string, any>]
    expect(last[0].content.body).toContain("incident:alarmWaiting")

    // A fix every second must not become a request every second.
    later(1_000)
    await checkIncident()
    await settle()
    expect(mockRaiseSos).toHaveBeenCalledTimes(1)

    // An upload that just went through says the server can be reached.
    await checkIncident({ online: true })
    await settle()
    expect(mockRaiseSos).toHaveBeenCalledTimes(2)
    expect(useIncidentStore.getState().pending).toBeNull()
  })

  it("waits out the ladder after a 429, however many uploads get through", async () => {
    // On Live an upload goes every second, and each one skipping the wait
    // would be a POST a second into a firewall that blocks on a 4xx.
    mockRaiseSos.mockRejectedValueOnce(new ApiError(429, "rate_limited", "Slow down"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    for (let i = 0; i < 5; i += 1) {
      later(1_000)
      await checkIncident({ online: true })
      await settle()
    }
    expect(mockRaiseSos).toHaveBeenCalledTimes(1)

    later(15_000)
    await checkIncident({ online: true })
    await settle()
    expect(mockRaiseSos).toHaveBeenCalledTimes(2)
  })

  it("puts its notice back after a restart, since a reboot clears notifications", async () => {
    mockRaiseSos.mockRejectedValueOnce(new ApiError(0, "network_error", "offline"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    mockSchedule.mockClear()

    await useIncidentStore.persist.rehydrate()
    later(1_000)
    await checkIncident()
    await settle()

    const [request] = mockSchedule.mock.calls[0] as [Record<string, any>]
    expect(request.content.body).toContain("incident:alarmWaiting")
  })

  it("tries again on its own once enough time has passed", async () => {
    mockRaiseSos.mockRejectedValueOnce(new ApiError(503, "unavailable", "deploying"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    later(60_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).toHaveBeenCalledTimes(2)
    expect(useIncidentStore.getState().pending).toBeNull()
  })

  it("survives a restart halfway, because the decision is in the store", async () => {
    mockRaiseSos.mockRejectedValueOnce(new ApiError(0, "network_error", "offline"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    const saved = useIncidentStore.getState().pending
    useIncidentStore.setState({ pending: null })
    useIncidentStore.setState({ pending: saved })

    later(10 * 60_000)
    await checkIncident()
    await settle()

    // Past the stale line, and still sent, because it was decided before it.
    expect(mockRaiseSos).toHaveBeenCalledTimes(2)
  })

  it("leaves it to the person once too long has passed to decide alone", async () => {
    await raiseIncident(impact())
    later(6 * 60_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).not.toHaveBeenCalled()
    const last = mockSchedule.mock.calls.at(-1) as [Record<string, any>]
    expect(last[0].content.body).toContain("incident:alarmStale")

    await escalateIncident()
    await settle()
    expect(mockRaiseSos).toHaveBeenCalledTimes(1)
  })

  it("forgets an incident an hour old, and takes its notification with it", async () => {
    await raiseIncident(impact())
    later(61 * 60_000)
    await checkIncident()

    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
    expect(mockRaiseSos).not.toHaveBeenCalled()
  })

  it("never asks the server anything without a session", async () => {
    mockTokens = null
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident({ online: true })
    await settle()

    expect(mockRaiseSos).not.toHaveBeenCalled()
    expect(useIncidentStore.getState().pending?.escalatedAt).not.toBeNull()
  })

  it("goes with the session, notification and all, since nothing could send it", async () => {
    mockRaiseSos.mockRejectedValueOnce(new ApiError(0, "network_error", "offline"))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    mockDismiss.mockClear()

    useAuthStore.getState().signedOut()
    await settle()

    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
  })

  it("does not send one account's incident for the next one to sign in", async () => {
    await raiseIncident(impact())
    useAuthStore.setState({ user: { id: "someone-else" } as never })
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).not.toHaveBeenCalled()
    expect(useIncidentStore.getState().pending).toBeNull()
  })
})

describe("which circle it goes through", () => {
  it("picks a circle that turned incident alerts on, over the one on screen", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("c1", false), circle("c2", true)])
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).toHaveBeenCalledWith("c2", expect.any(String), "incident")
    expect(mockCircles).not.toHaveBeenCalled()
  })

  it("asks the server for the circles when nothing has loaded them", async () => {
    mockCircles.mockResolvedValue([circle("c3", true)])
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()

    expect(mockRaiseSos).toHaveBeenCalledWith("c3", expect.any(String), "incident")
  })

  it("sends nothing when I'm okay lands while it looks the circle up", async () => {
    const lookup = deferred<Circle[]>()
    mockCircles.mockReturnValue(lookup.promise)
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    const sending = checkIncident()
    await settle()

    await dismissIncident()
    lookup.resolve([circle("c3", true)])
    await sending
    await settle()

    expect(mockRaiseSos).not.toHaveBeenCalled()
  })

  it("gives up on a refusal rather than asking again into a firewall", async () => {
    mockRaiseSos.mockRejectedValue(new ApiError(403, "forbidden", "No."))
    await raiseIncident(impact())
    later(INCIDENT_COUNTDOWN_MS + 1_000)
    await checkIncident()
    await settle()
    later(5 * 60_000)
    await checkIncident({ online: true })
    await settle()

    expect(mockRaiseSos).toHaveBeenCalledTimes(1)
    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
  })
})

describe("answering", () => {
  it("cancels it from the notification's I'm okay, without the app", async () => {
    await raiseIncident(impact())
    const handled = await answerIncidentResponse(okFor())
    later(INCIDENT_COUNTDOWN_MS + 10_000)
    await checkIncident()
    await settle()

    expect(handled).toBe(true)
    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
    expect(mockRaiseSos).not.toHaveBeenCalled()
  })

  it("never lets an I'm okay left over from an earlier incident cancel a later one", async () => {
    // Android keeps the last response, and an app opened hours later reads it
    // back as if it had just been tapped.
    await raiseIncident(impact())
    const earlier = okFor()
    await answerIncidentResponse(earlier)
    expect(mockClearLast).toHaveBeenCalled()

    later(2 * 60 * 60_000)
    await raiseIncident(impact())
    await answerIncidentResponse(earlier)

    expect(useIncidentStore.getState().pending?.detectedAt).toBe(Date.now())
  })

  it("posts nothing for an incident answered while its notice was on the way", async () => {
    const category = deferred<null>()
    mockCategory.mockReturnValueOnce(category.promise)
    useIncidentStore.getState().raise(impact(), "me")
    const posting = checkIncident()
    await settle()

    await dismissIncident()
    category.resolve(null)
    await posting

    expect(mockSchedule).not.toHaveBeenCalled()
  })

  it("leaves other notifications to whoever handles them", async () => {
    const handled = await answerIncidentResponse({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { identifier: "x", content: { data: { type: "sos_started" } } } },
    })
    expect(handled).toBe(false)
  })

  it("cancels it from the prompt, and takes the notification away", async () => {
    await raiseIncident(impact())
    await dismissIncident()

    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
  })
})

// A crashed car does not drive on, and a phone dropped in the footwell of
// one that does is the commonest jolt there is.
describe("a car that drives on", () => {
  const fix = (msAfterJolt: number, speedMps: number, accuracyMeters = 8) => ({
    recordedAt: new Date(START + msAfterJolt).toISOString(),
    lat: 51.45,
    lon: -2.58,
    speedMps,
    accuracyMeters,
  })

  it("takes the question back before anybody is alerted", async () => {
    await raiseIncident(impact(START))
    noteIncidentFix(fix(12_000, 14))
    await settle()
    later(INCIDENT_COUNTDOWN_MS + 10_000)
    await checkIncident()
    await settle()

    expect(useIncidentStore.getState().pending).toBeNull()
    expect(mockDismiss).toHaveBeenCalledWith(INCIDENT_NOTIFICATION_ID)
    expect(mockRaiseSos).not.toHaveBeenCalled()
  })

  it("is not read from the jolt itself, a crawl, or a fix too loose to trust", async () => {
    await raiseIncident(impact(START))
    noteIncidentFix(fix(1_000, 20))
    noteIncidentFix(fix(12_000, 2))
    noteIncidentFix(fix(12_000, 20, 400))
    await settle()

    expect(useIncidentStore.getState().pending).not.toBeNull()
  })

  it("does not call off an alert that has already gone", async () => {
    await raiseIncident(impact(START))
    later(INCIDENT_COUNTDOWN_MS + 10_000)
    useIncidentStore.getState().update({ escalatedAt: Date.now(), failure: "network" })
    noteIncidentFix(fix(INCIDENT_COUNTDOWN_MS + 20_000, 14))
    await settle()

    expect(useIncidentStore.getState().pending).not.toBeNull()
  })
})
