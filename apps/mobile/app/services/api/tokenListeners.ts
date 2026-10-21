/** Told of every new pair once it is stored. The tracker hands the upload key to its native side. */
export const tokenListeners = new Set<() => void>()
