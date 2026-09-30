import { activityIconName } from "./activity"

describe("activityIconName", () => {
  it("draws what the phone said it was doing", () => {
    expect(activityIconName("walking", 1.4)).toBe("walk")
    expect(activityIconName("cycling", 6)).toBe("bicycle")
    expect(activityIconName("driving", 25)).toBe("car")
  })

  // A drive handed over late by the native queue came up labelled walking.
  it("draws a car when nobody on foot could be going that fast", () => {
    expect(activityIconName("walking", 22.5)).toBe("car")
  })

  it("trusts the label when no speed was measured", () => {
    expect(activityIconName("walking", null)).toBe("walk")
    expect(activityIconName("still", null)).toBeNull()
  })
})
