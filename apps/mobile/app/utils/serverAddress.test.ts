import { isLocalHost, serverCandidates } from "./serverAddress"

describe("serverCandidates", () => {
  it("never tries plain HTTP for a public name whose HTTPS failed", () => {
    expect(serverCandidates("hearth.example.com")).toEqual(["https://hearth.example.com"])
    expect(serverCandidates("hearth.example.com:8443/")).toEqual([
      "https://hearth.example.com:8443",
    ])
  })

  it("falls back to plain HTTP for an address only the local network can have", () => {
    expect(serverCandidates("192.168.1.10:4000")).toEqual([
      "https://192.168.1.10:4000",
      "http://192.168.1.10:4000",
    ])
    expect(serverCandidates("nas.local")).toEqual(["https://nas.local", "http://nas.local"])
  })

  it("takes a typed scheme as the answer", () => {
    expect(serverCandidates("http://hearth.example.com")).toEqual(["http://hearth.example.com"])
  })

  it("has nothing to try for an empty field", () => {
    expect(serverCandidates("   ")).toEqual([])
  })
})

describe("isLocalHost", () => {
  it.each([
    "localhost",
    "nas",
    "hearth.lan",
    "hearth.home.arpa",
    "10.0.0.2",
    "172.20.1.1",
    "127.0.0.1",
    "169.254.10.1",
    "100.101.102.103",
    "::1",
    "fd12:3456::1",
    "fe80::1",
  ])("%s is local", (host) => {
    expect(isLocalHost(host)).toBe(true)
  })

  it.each(["hearth.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1"])(
    "%s is not",
    (host) => {
      expect(isLocalHost(host)).toBe(false)
    },
  )
})
