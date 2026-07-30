import { reportHealth } from "./health"

const mockHealth = jest.fn(async () => ({ ok: true }))
jest.mock("@/services/api", () => ({
  endpoints: { auth: { health: (...args: unknown[]) => mockHealth(...(args as [])) } },
}))
let mockSnapshot = {
  location: "always",
  servicesEnabled: true,
  preciseLocation: true,
  notifications: "granted",
  batteryOptimization: "n/a",
  backgroundRefresh: "available",
}
jest.mock("@/services/permissions", () => ({
  getPermissionSnapshot: jest.fn(async () => mockSnapshot),
}))
jest.mock("@/stores/auth", () => ({
  useAuthStore: { getState: () => ({ status: "signed_in" }) },
}))

describe("reportHealth", () => {
  beforeEach(() => {
    mockHealth.mockClear()
    require("@/utils/storage").clear()
  })

  it("tells the server once, and again only when something changes", async () => {
    await reportHealth()
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(1)
    expect(mockHealth).toHaveBeenCalledWith({
      locationPermission: "always",
      locationServices: true,
      backgroundRefresh: "available",
    })

    mockSnapshot = { ...mockSnapshot, location: "foreground" }
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
    expect(mockHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ locationPermission: "foreground" }),
    )
  })

  it("keeps quiet when the server cannot be reached, and tries again next time", async () => {
    mockHealth.mockRejectedValueOnce(new Error("offline"))
    await reportHealth()
    await reportHealth()
    expect(mockHealth).toHaveBeenCalledTimes(2)
  })
})
