import type { ServerSettings } from "@hearth/shared"
import { describe, expect, it } from "vitest"

import { changesFrom, draftOf, followServer } from "./settings-draft"

const saved: ServerSettings = {
  serverName: "Home",
  registrationMode: "invite",
  maxHistoryRetentionDays: null,
}

describe("the settings form's draft", () => {
  it("starts from what the server holds", () => {
    expect(draftOf(saved)).toEqual({ name: "Home", mode: "invite", ceiling: "" })
    expect(draftOf({ ...saved, maxHistoryRetentionDays: 30 }).ceiling).toBe("30")
  })

  it("has no changes until something differs from what is saved", () => {
    expect(changesFrom(draftOf(saved), saved)).toEqual({})
    expect(changesFrom({ ...draftOf(saved), name: " Home " }, saved)).toEqual({})
    expect(changesFrom({ name: "Cabin", mode: "closed", ceiling: "45" }, saved)).toEqual({
      serverName: "Cabin",
      registrationMode: "closed",
      maxHistoryRetentionDays: 45,
    })
    expect(
      changesFrom({ ...draftOf(saved), ceiling: "" }, { ...saved, maxHistoryRetentionDays: 30 }),
    ).toEqual({ maxHistoryRetentionDays: null })
  })

  it("follows the server when nothing has been edited", () => {
    const next = { ...saved, serverName: "Cabin" }
    expect(followServer(draftOf(saved), saved, next)).toEqual(draftOf(next))
  })

  it("keeps unsaved edits when the server's values change underneath them", () => {
    const edited = { ...draftOf(saved), ceiling: "60" }
    expect(followServer(edited, saved, { ...saved, serverName: "Cabin" })).toBe(edited)
  })

  it("keeps the draft as it is once the server holds what was saved", () => {
    const edited = { ...draftOf(saved), name: "Cabin" }
    const after = followServer(edited, saved, { ...saved, serverName: "Cabin" })
    expect(after).toBe(edited)
    expect(changesFrom(after, { ...saved, serverName: "Cabin" })).toEqual({})
  })
})
