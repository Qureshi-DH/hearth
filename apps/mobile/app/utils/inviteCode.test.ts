import { cleanInviteCode } from "./inviteCode"

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
