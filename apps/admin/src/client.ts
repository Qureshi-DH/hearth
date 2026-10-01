import { createClient, type SignOutReason } from "./api"

/** Raised on window when the session ends, whichever call found out. Its detail is the reason. */
export const SIGNED_OUT = "hearth:signed-out"

export type SignedOutEvent = CustomEvent<SignOutReason>

export const client = createClient({
  storage: browserStorage(),
  onSignedOut: (reason) => window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: reason })),
})

/** Reading localStorage throws in some locked-down browsers rather than returning null. */
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
