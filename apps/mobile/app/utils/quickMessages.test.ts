import { QUICK_MESSAGES, type MemberPresence } from "@hearth/shared"

import { ApiError } from "@/services/api"

import { quickMessagesFor, sendQuickMessage } from "./quickMessages"

type Situation = Pick<
  MemberPresence,
  "batteryLevel" | "isCharging" | "activity" | "speedMps" | "stale" | "issues"
>

const usual: Situation = {
  batteryLevel: 0.8,
  isCharging: false,
  activity: "still",
  speedMps: 0,
  stale: false,
  issues: [],
}

const keys = (situation: Situation | null) => quickMessagesFor(situation).map((quick) => quick.key)
const everyKey = QUICK_MESSAGES.map((quick) => quick.key)

describe("quickMessagesFor", () => {
  it("offers the usual order when nothing stands out", () => {
    expect(keys(usual)).toEqual(everyKey)
    expect(keys(null)).toEqual(everyKey)
  })

  it("puts charging first for a phone running out", () => {
    expect(keys({ ...usual, batteryLevel: 0.09 })[0]).toBe("charge_phone")
  })

  it("does not nag a phone that is already on its charger", () => {
    expect(keys({ ...usual, batteryLevel: 0.09, isCharging: true })[0]).not.toBe("charge_phone")
  })

  it("asks a phone that has gone quiet to open Hearth", () => {
    expect(keys({ ...usual, stale: true }).slice(0, 2)).toEqual(["open_hearth", "where_are_you"])
    expect(keys({ ...usual, issues: ["location_services"] })[0]).toBe("open_hearth")
  })

  it("leads with the road for somebody driving", () => {
    expect(keys({ ...usual, activity: "driving", speedMps: 25 }).slice(0, 2)).toEqual([
      "slow_down",
      "drive_safe",
    ])
  })

  it("reads a car from the speed when the label says walking", () => {
    expect(keys({ ...usual, activity: "walking", speedMps: 22 })[0]).toBe("slow_down")
  })

  it("uses the circle's own low battery line", () => {
    const at20 = { ...usual, batteryLevel: 0.2 }
    expect(quickMessagesFor(at20)[0]!.key).not.toBe("charge_phone")
    expect(quickMessagesFor(at20, 0.25)[0]!.key).toBe("charge_phone")
  })

  // A server from before phones reported their health sends no issues at all.
  it("copes with a server that sends no issues", () => {
    const older = { ...usual, issues: undefined } as unknown as Situation
    expect(keys(older)).toEqual(everyKey)
  })

  it("keeps every message on offer, whatever comes first", () => {
    const busy = keys({ ...usual, batteryLevel: 0.05, stale: true })
    expect(busy.slice(0, 2)).toEqual(["charge_phone", "open_hearth"])
    expect([...busy].sort()).toEqual([...everyKey].sort())
  })
})

describe("sendQuickMessage", () => {
  const charge = QUICK_MESSAGES.find((quick) => quick.key === "charge_phone")!

  it("sends the message by its key", async () => {
    const send = jest.fn(async () => {})
    await sendQuickMessage(send, charge)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ quickKey: "charge_phone" })
  })

  // The store app updates before a family's own server does, and a server
  // from before the message was added refuses its key.
  it("sends the same words as text to a server that does not know the key", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new ApiError(400, "validation_error", "Invalid body"))
      .mockResolvedValueOnce(undefined)
    await sendQuickMessage(send, charge)
    expect(send).toHaveBeenLastCalledWith({ body: "Please charge your phone." })
  })

  it("does not retry anything else that went wrong", async () => {
    const send = jest.fn().mockRejectedValue(new ApiError(403, "forbidden", "Paused"))
    await expect(sendQuickMessage(send, charge)).rejects.toThrow("Paused")
    expect(send).toHaveBeenCalledTimes(1)
  })
})
