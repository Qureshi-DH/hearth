import { describeProbeFailure, plainHttpCanReach, plainHttpReach } from "./serverProbe"

let mockExtra: Record<string, unknown> = {}
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra }
    },
  },
}))

const refused = new Error("Network request failed")

const runtime = globalThis as unknown as { __DEV__: boolean }

/** Runs the body as a release build on one platform, and puts the test's own back after. */
function asRelease(platform: "android" | "ios", body: () => void) {
  const { Platform } = require("react-native")
  const os = Platform.OS
  const dev = runtime.__DEV__
  Platform.OS = platform
  runtime.__DEV__ = false
  try {
    body()
  } finally {
    Platform.OS = os
    runtime.__DEV__ = dev
  }
}

describe("where this build can send plain HTTP", () => {
  beforeEach(() => {
    mockExtra = {}
  })

  it("is nowhere for an Android release, which blocks cleartext to every host", () => {
    asRelease("android", () => expect(plainHttpReach()).toBe("none"))
  })

  it("is the local network for an iOS release", () => {
    asRelease("ios", () => expect(plainHttpReach()).toBe("local"))
  })

  it("is anywhere for a build made to allow it", () => {
    mockExtra = { plainHttp: true }
    asRelease("android", () => expect(plainHttpReach()).toBe("any"))
    asRelease("ios", () => expect(plainHttpReach()).toBe("any"))
  })

  it("lets iOS reach a home server but not a public name", () => {
    expect(plainHttpCanReach("https://192.168.1.10:4000", "local")).toBe(true)
    expect(plainHttpCanReach("http://nas.local", "local")).toBe(true)
    expect(plainHttpCanReach("https://hearth.example.com", "local")).toBe(false)
  })
})

describe("what the server screen says when nothing answered", () => {
  it("never tells an Android release to type http://", () => {
    expect(describeProbeFailure(refused, ["https://hearth.example.com"], "none")).toBe(
      "server:httpsOnly",
    )
    expect(
      describeProbeFailure(
        refused,
        ["https://192.168.1.10:4000", "http://192.168.1.10:4000"],
        "none",
      ),
    ).toBe("server:httpsOnly")
  })

  it("says why an http:// address can't work in a build that blocks it", () => {
    expect(describeProbeFailure(refused, ["http://192.168.1.10:4000"], "none")).toBe(
      "server:httpBlocked",
    )
    expect(describeProbeFailure(refused, ["http://hearth.example.com"], "local")).toBe(
      "server:httpBlocked",
    )
  })

  it("still suggests http:// where the build could use it", () => {
    expect(describeProbeFailure(refused, ["https://hearth.example.com"], "any")).toBe(
      "server:noHttps",
    )
    expect(describeProbeFailure(refused, ["https://192.168.1.10:4000"], "local")).toBe(
      "server:noHttps",
    )
    expect(describeProbeFailure(refused, ["https://hearth.example.com"], "local")).toBe(
      "server:httpsOnly",
    )
  })

  it("calls a plain HTTP address the build could reach simply unreachable", () => {
    expect(describeProbeFailure(refused, ["http://nas.local"], "local")).toBe("server:invalid")
  })

  it("keeps the answers that don't depend on the scheme", () => {
    expect(describeProbeFailure(new Error("Aborted"), ["https://a.example"], "none")).toBe(
      "server:timeout",
    )
    expect(
      describeProbeFailure(new Error("Something answered"), ["https://a.example"], "none"),
    ).toBe("server:notHearth")
  })
})
