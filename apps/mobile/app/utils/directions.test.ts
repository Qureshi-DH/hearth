import { Linking, Platform } from "react-native"

import { availableDirectionsApps, directionsUrl } from "./directions"

describe("directions", () => {
  const os = Platform.OS
  afterEach(() => {
    Platform.OS = os
    jest.restoreAllMocks()
  })

  it("offers Google Maps on iOS only when it is installed", async () => {
    Platform.OS = "ios"
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(false)
    expect(await availableDirectionsApps()).toEqual(["apple"])
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(true)
    expect(await availableDirectionsApps()).toEqual(["apple", "google"])
  })

  it("leaves the choice to Android, which asks through its own chooser", async () => {
    Platform.OS = "android"
    const canOpen = jest.spyOn(Linking, "canOpenURL")
    canOpen.mockClear()
    expect(await availableDirectionsApps()).toHaveLength(1)
    expect(canOpen).not.toHaveBeenCalled()
    expect(directionsUrl("google", 51.5, -0.1, "Ana")).toMatch(/^geo:51.5,-0.1/)
  })

  it("opens each iOS app through its own scheme", () => {
    Platform.OS = "ios"
    expect(directionsUrl("apple", 51.5, -0.1, "Ana")).toBe("maps://?daddr=51.5,-0.1")
    expect(directionsUrl("google", 51.5, -0.1, "Ana")).toMatch(
      /^comgooglemaps:\/\/\?daddr=51.5,-0.1/,
    )
  })
})
