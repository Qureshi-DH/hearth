import {
  backgroundRefreshStatus,
  ensureMotionPermission,
  motionPermission,
  startMotion,
} from "./motion"

/**
 * modules/hearth-motion/index.ts calls requireNativeModule at import time, so
 * the module file itself is what gets replaced, not a native binding under it.
 */
jest.mock("../../../modules/hearth-motion", () => ({
  default: {
    isAvailableAsync: jest.fn(async () => true),
    getPermissionAsync: jest.fn(async () => "undetermined"),
    requestPermissionAsync: jest.fn(async () => "granted"),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    startUpdatesAsync: jest.fn(async () => {}),
    stopUpdatesAsync: jest.fn(async () => {}),
    getBackgroundRefreshStatusAsync: jest.fn(async () => "available"),
  },
}))

type NativeMock = Record<
  | "isAvailableAsync"
  | "getPermissionAsync"
  | "requestPermissionAsync"
  | "addListener"
  | "startUpdatesAsync"
  | "stopUpdatesAsync"
  | "getBackgroundRefreshStatusAsync",
  jest.Mock
>

const native = (jest.requireMock("../../../modules/hearth-motion") as { default: NativeMock })
  .default

beforeEach(() => {
  jest.clearAllMocks()
  native.isAvailableAsync.mockResolvedValue(true)
  native.getPermissionAsync.mockResolvedValue("undetermined")
  native.requestPermissionAsync.mockResolvedValue("granted")
})

describe("startMotion", () => {
  it("never prompts", async () => {
    // The tracker starts the classifier from a geofence wake, which on Android
    // can be a process with no Activity. A request made from there resolves
    // denied with no dialog, and the module remembers having asked, so one
    // background start would turn the permission off for good.
    await expect(startMotion(jest.fn())).resolves.toBeNull()

    expect(native.requestPermissionAsync).not.toHaveBeenCalled()
    expect(native.startUpdatesAsync).not.toHaveBeenCalled()
  })

  it("runs once the permission has been granted", async () => {
    native.getPermissionAsync.mockResolvedValue("granted")

    await expect(startMotion(jest.fn())).resolves.not.toBeNull()

    expect(native.addListener).toHaveBeenCalledWith("onMotionChange", expect.any(Function))
    expect(native.startUpdatesAsync).toHaveBeenCalled()
    expect(native.requestPermissionAsync).not.toHaveBeenCalled()
  })

  it("stays off where the hardware cannot classify motion", async () => {
    native.isAvailableAsync.mockResolvedValue(false)
    native.getPermissionAsync.mockResolvedValue("granted")

    await expect(startMotion(jest.fn())).resolves.toBeNull()

    expect(native.startUpdatesAsync).not.toHaveBeenCalled()
  })
})

describe("ensureMotionPermission", () => {
  it("is the one path that asks", async () => {
    await expect(ensureMotionPermission()).resolves.toBe(true)

    expect(native.requestPermissionAsync).toHaveBeenCalledTimes(1)
  })

  it("does not ask again once the answer is known", async () => {
    native.getPermissionAsync.mockResolvedValue("denied")
    await expect(ensureMotionPermission()).resolves.toBe(false)

    native.getPermissionAsync.mockResolvedValue("granted")
    await expect(ensureMotionPermission()).resolves.toBe(true)

    expect(native.requestPermissionAsync).not.toHaveBeenCalled()
  })
})

describe("motionPermission", () => {
  it("reads unavailable where the hardware cannot classify motion", async () => {
    // A simulator or an old phone has nothing to grant, so the checklist hides
    // the row rather than asking for something that can never turn on.
    native.isAvailableAsync.mockResolvedValue(false)

    await expect(motionPermission()).resolves.toBe("unavailable")
  })
})

describe("backgroundRefreshStatus", () => {
  it("passes the switch through as UIApplication reports it", async () => {
    native.getBackgroundRefreshStatusAsync.mockResolvedValue("denied")
    await expect(backgroundRefreshStatus()).resolves.toBe("denied")
  })

  it("is unknown where the module cannot say, which Android cannot", async () => {
    native.getBackgroundRefreshStatusAsync.mockRejectedValue(new Error("not on this platform"))
    await expect(backgroundRefreshStatus()).resolves.toBe("unknown")
  })
})

describe("a build without the module", () => {
  it("degrades to GPS only rather than crash on import", async () => {
    let degraded: typeof import("./motion") | undefined
    // The fake the rest of the file runs on is already instantiated in the
    // mock registry, and an isolated registry falls back to that before it
    // consults a new factory. Bindings taken at the top of the file survive
    // the reset, so the suites above are unaffected.
    jest.resetModules()
    jest.isolateModules(() => {
      jest.doMock("../../../modules/hearth-motion", () => {
        throw new Error("Cannot find native module 'HearthMotion'")
      })
      degraded = require("./motion")
    })
    if (!degraded) throw new Error("motion.ts did not load")

    expect(degraded.motionModuleAvailable).toBe(false)
    await expect(degraded.motionPermission()).resolves.toBe("unavailable")
    await expect(degraded.startMotion(jest.fn())).resolves.toBeNull()
    await expect(degraded.ensureMotionPermission()).resolves.toBe(false)
  })
})
