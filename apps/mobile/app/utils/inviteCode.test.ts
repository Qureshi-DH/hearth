import { cleanInviteCode, inviteQrValue, parseInviteLink } from "./inviteCode"

describe("cleanInviteCode", () => {
  it("keeps a code as the server reads it", () => {
    expect(cleanInviteCode("abcd1234")).toBe("ABCD1234")
  })

  // A link can carry anything after /join/, and the preview would send it as is.
  it("drops what a link carried in that no code holds", () => {
    expect(cleanInviteCode("abcd-1234 ")).toBe("ABCD1234")
  })

  it("stops at the longest code the server takes", () => {
    expect(cleanInviteCode("A".repeat(40))).toHaveLength(16)
  })
})

describe("parseInviteLink", () => {
  it("reads the app link the join page opens, server and all", () => {
    expect(
      parseInviteLink(
        `hearth://join/ab12cd34?server=${encodeURIComponent("https://hearth.example.com")}`,
      ),
    ).toEqual({ code: "AB12CD34", server: "https://hearth.example.com" })
  })

  it("reads a server that sits at a path", () => {
    const server = encodeURIComponent("https://lab.example.com/hearth/")
    expect(parseInviteLink(`hearth://join/AB12CD34?server=${server}`)).toEqual({
      code: "AB12CD34",
      server: "https://lab.example.com/hearth",
    })
  })

  // What every QR and join page made before the server went into the link holds.
  it("still reads an app link with no server in it", () => {
    expect(parseInviteLink("hearth://join/AB12CD34")).toEqual({ code: "AB12CD34", server: null })
  })

  it("takes the server from a shared web link", () => {
    expect(parseInviteLink("https://hearth.example.com/join/AB12CD34")).toEqual({
      code: "AB12CD34",
      server: "https://hearth.example.com",
    })
    expect(parseInviteLink("https://lab.example.com/hearth/join/AB12CD34/")).toEqual({
      code: "AB12CD34",
      server: "https://lab.example.com/hearth",
    })
    expect(parseInviteLink("http://192.168.1.10:4000/join/AB12CD34")).toEqual({
      code: "AB12CD34",
      server: "http://192.168.1.10:4000",
    })
  })

  it("reads a development build's link", () => {
    expect(parseInviteLink("exp://192.168.1.5:8081/--/join/AB12CD34")).toEqual({
      code: "AB12CD34",
      server: null,
    })
  })

  it("takes a bare code, as somebody might have made a QR of one", () => {
    expect(parseInviteLink(" ab12cd34 ")).toEqual({ code: "AB12CD34", server: null })
  })

  // A link is whatever somebody sent, and the server field is filled from it.
  it("ignores a server that is not a web address", () => {
    expect(parseInviteLink("hearth://join/AB12CD34?server=javascript%3Aalert(1)")).toEqual({
      code: "AB12CD34",
      server: null,
    })
    expect(parseInviteLink("hearth://join/AB12CD34?server=%E0%A4%A")).toEqual({
      code: "AB12CD34",
      server: null,
    })
  })

  it("finds nothing in something that is not an invite", () => {
    expect(parseInviteLink("https://example.com/rejoin")).toBeNull()
    expect(parseInviteLink("hearth://circles/1/sos")).toBeNull()
    expect(parseInviteLink("")).toBeNull()
    expect(parseInviteLink("hello there")).toBeNull()
  })
})

describe("inviteQrValue", () => {
  const invite = { code: "AB12CD34", url: "https://lab.example.com/hearth/join/AB12CD34" }

  // A phone camera opens it in the browser, where the join page explains the
  // rest to somebody without the app.
  it("is the web link, which carries the server", () => {
    expect(inviteQrValue(invite)).toBe(invite.url)
    expect(parseInviteLink(inviteQrValue(invite))).toEqual({
      code: "AB12CD34",
      server: "https://lab.example.com/hearth",
    })
  })

  // What an app from before this does with a scanned QR.
  it("still gives an older app's scanner the code", () => {
    const olderScanner = (raw: string) => raw.trim().match(/([A-Z0-9]{6,16})\s*$/i)?.[1]
    expect(olderScanner(inviteQrValue(invite))).toBe("AB12CD34")
  })

  it("falls back to the app link when the server sent no web link", () => {
    expect(inviteQrValue({ code: "AB12CD34", url: "" })).toBe("hearth://join/AB12CD34")
  })
})
