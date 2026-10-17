import { translate } from "./translate"

// babel-jest hoists these above the imports, so the real i18next and strings load.
jest.unmock("i18next")
jest.unmock("./index")

/** One of anything is never "1 members". */
describe("counted strings", () => {
  it.each([
    ["circles:members", "1 member", "3 members"],
    ["admin:usersCount", "1 user", "4 users"],
    ["admin:circlesCount", "1 circle", "2 circles"],
    ["admin:retentionDays", "1 day", "90 days"],
    ["settings:dataStored", "1 location point stored", "0 location points stored"],
    ["settings:queued", "1 fix waiting to upload", "12 fixes waiting to upload"],
  ] as const)("%s agrees with its count", (key, one, many) => {
    expect(translate(key, { count: 1 })).toBe(one)
    const count = Number(many.split(" ")[0])
    expect(translate(key, { count })).toBe(many)
  })
})

describe("counted sentences", () => {
  it("says a day, not 1 days, for a server that keeps history a day", () => {
    expect(translate("circle:retentionCeiling", { count: 1 })).toBe(
      "This server deletes location history after 1 day, so no circle can keep it longer.",
    )
    expect(translate("circle:retentionCeiling", { count: 90 })).toBe(
      "This server deletes location history after 90 days, so no circle can keep it longer.",
    )
  })
})
