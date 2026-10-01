import type { AdminAuditEntry } from "@hearth/shared"
import { describe, expect, it } from "vitest"

import { auditIp, describeAuditEntry } from "./audit"

const entry = (overrides: Partial<AdminAuditEntry>): AdminAuditEntry => ({
  id: "a1",
  actorUserId: "u1",
  actorName: "Daniyal",
  action: "user.update",
  targetType: "user",
  targetId: "u2",
  targetName: "Sabeen",
  meta: {},
  ip: "203.0.113.7",
  createdAt: "2026-10-01T12:00:00Z",
  ...overrides,
})

const says = (overrides: Partial<AdminAuditEntry>) => describeAuditEntry(entry(overrides))

describe("an audit entry in words", () => {
  describe("settings.update", () => {
    const settings = (meta: Record<string, unknown>) =>
      says({ action: "settings.update", targetType: "server", targetName: null, meta })

    it("says each thing that changed", () => {
      expect(settings({ serverName: "Home" })).toBe("Daniyal renamed the server to Home")
      expect(settings({ registrationMode: "invite" })).toBe("Daniyal set sign-up to invite only")
      expect(settings({ registrationMode: "open" })).toBe("Daniyal set sign-up to anyone")
      expect(settings({ registrationMode: "closed" })).toBe("Daniyal set sign-up to nobody")
      expect(settings({ maxHistoryRetentionDays: 30 })).toBe("Daniyal limited history to 30 days")
      expect(settings({ maxHistoryRetentionDays: null })).toBe(
        "Daniyal handed the history limit back to .env",
      )
    })

    it("joins several changes into one line", () => {
      expect(settings({ serverName: "Home", registrationMode: "closed" })).toBe(
        "Daniyal renamed the server to Home, set sign-up to nobody",
      )
    })

    it("falls back to a plain line when it cannot tell what changed", () => {
      expect(settings({})).toBe("Daniyal saved the server settings")
      expect(settings({ registrationMode: "lottery" })).toBe("Daniyal set sign-up to lottery")
    })
  })

  describe("user.update", () => {
    const update = (meta: Record<string, unknown>) => says({ action: "user.update", meta })

    it("says what was done to the account", () => {
      expect(update({ isActive: false })).toBe("Daniyal deactivated Sabeen")
      expect(update({ isActive: true })).toBe("Daniyal reactivated Sabeen")
      expect(update({ isAdmin: true })).toBe("Daniyal made Sabeen an administrator")
      expect(update({ isAdmin: false })).toBe("Daniyal removed Sabeen as an administrator")
      expect(update({})).toBe("Daniyal changed Sabeen's account")
    })
  })

  it("user.password", () => {
    expect(says({ action: "user.password" })).toBe("Daniyal set a new password for Sabeen")
  })

  it("session.revoke, by the device's name when it had one", () => {
    expect(says({ action: "session.revoke", meta: { deviceName: "Pixel 9" } })).toBe(
      "Daniyal signed Sabeen out of Pixel 9",
    )
    expect(says({ action: "session.revoke", meta: { deviceName: null } })).toBe(
      "Daniyal signed Sabeen out of a device",
    )
  })

  it("session.revoke_all", () => {
    expect(says({ action: "session.revoke_all", meta: { count: 3 } })).toBe(
      "Daniyal signed Sabeen out everywhere",
    )
  })

  it("session.refresh_reuse", () => {
    expect(
      says({
        action: "session.refresh_reuse",
        actorName: "Sabeen",
        targetType: "session",
        targetName: null,
      }),
    ).toBe("A sign-in token of Sabeen's was used twice, so that session was ended")
  })

  it("portal.sign_in", () => {
    expect(says({ action: "portal.sign_in", targetName: "Daniyal" })).toBe(
      "Daniyal signed in to the portal",
    )
  })

  it("an action it does not know, by its name", () => {
    expect(says({ action: "circle.delete" })).toBe("Daniyal: circle.delete")
  })

  it("names nobody it cannot name", () => {
    expect(says({ action: "user.password", actorName: null, targetName: null })).toBe(
      "Somebody set a new password for an account",
    )
  })
})

describe("the address an audit entry came from", () => {
  it("is shown for what an administrator did", () => {
    for (const action of [
      "settings.update",
      "user.update",
      "user.password",
      "session.revoke",
      "session.revoke_all",
      "portal.sign_in",
    ]) {
      expect(auditIp(entry({ action }))).toBe("203.0.113.7")
    }
  })

  it("is not shown for a reused token, which is usually the member's own phone", () => {
    expect(auditIp(entry({ action: "session.refresh_reuse" }))).toBeNull()
  })

  it("is not shown for an action it does not know", () => {
    expect(auditIp(entry({ action: "circle.delete" }))).toBeNull()
  })
})
