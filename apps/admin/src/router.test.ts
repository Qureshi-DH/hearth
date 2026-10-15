import { describe, expect, it } from "vitest"

import { hrefFor, pageAt } from "./router"

describe("the portal's pages at the root of a domain", () => {
  it("finds the page in the address", () => {
    expect(pageAt("/", "")).toBe("/")
    expect(pageAt("/accounts", "")).toBe("/accounts")
    expect(pageAt("/accounts/", "")).toBe("/accounts")
    expect(pageAt("/no-such-page", "")).toBe("/")
  })

  it("writes the address a page lives at", () => {
    expect(hrefFor("/", "")).toBe("/")
    expect(hrefFor("/settings", "")).toBe("/settings")
  })
})

describe("the portal's pages under a path", () => {
  it("finds the page after the path", () => {
    expect(pageAt("/hearth", "/hearth")).toBe("/")
    expect(pageAt("/hearth/", "/hearth")).toBe("/")
    expect(pageAt("/hearth/accounts", "/hearth")).toBe("/accounts")
    expect(pageAt("/hearth/accounts/", "/hearth")).toBe("/accounts")
    expect(pageAt("/hearth/no-such-page", "/hearth")).toBe("/")
    expect(pageAt("/hearthstone", "/hearth")).toBe("/")
  })

  // The server answers with or without the path, so a page opened straight
  // from the server, past the proxy, still knows where it is.
  it("finds the page in an address without the path", () => {
    expect(pageAt("/accounts", "/hearth")).toBe("/accounts")
  })

  it("puts the path in front of every address", () => {
    expect(hrefFor("/", "/hearth")).toBe("/hearth/")
    expect(hrefFor("/accounts", "/hearth")).toBe("/hearth/accounts")
  })
})
