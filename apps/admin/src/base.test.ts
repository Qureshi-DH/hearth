import { describe, expect, it } from "vitest"

import { readBase } from "./base"

const pageWith = (content: string | null) => ({
  querySelector: (selector: string) =>
    selector === 'meta[name="hearth-base"]' && content !== null
      ? { getAttribute: (name: string) => (name === "content" ? content : null) }
      : null,
})

describe("where the server put the portal", () => {
  it("reads the path the server wrote into the page", () => {
    expect(readBase(pageWith("/hearth"))).toBe("/hearth")
    expect(readBase(pageWith("/hearth/"))).toBe("/hearth")
  })

  it("is the root of the domain when the page says so or says nothing", () => {
    expect(readBase(pageWith(""))).toBe("")
    expect(readBase(pageWith(null))).toBe("")
    expect(readBase(undefined)).toBe("")
  })
})
