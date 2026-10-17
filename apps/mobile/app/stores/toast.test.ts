import { toast, toastDuration, useToastStore } from "./toast"

const shown = () => useToastStore.getState().current?.message ?? null

describe("how long a toast stays up", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useToastStore.setState({ current: null })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("keeps a short error up for six seconds", () => {
    toast.error("Couldn't save")
    jest.advanceTimersByTime(5_900)
    expect(shown()).toBe("Couldn't save")
    jest.advanceTimersByTime(200)
    expect(shown()).toBeNull()
  })

  it("lets a short confirmation go quickly, as before", () => {
    toast.success("Saved")
    jest.advanceTimersByTime(2_700)
    expect(shown()).toBeNull()
  })

  it("gives a long message time to be read, whatever its tone", () => {
    const long =
      "Asked Aisha. No phone of theirs can be woken from here, so their location updates when they open Hearth."
    toast.info(long)
    jest.advanceTimersByTime(5_000)
    expect(shown()).toBe(long)
    expect(toastDuration(long, "error")).toBeGreaterThan(toastDuration("Couldn't save", "error"))
  })

  it("never holds the screen forever", () => {
    expect(toastDuration("x".repeat(2_000), "error")).toBeLessThanOrEqual(15_000)
  })
})
