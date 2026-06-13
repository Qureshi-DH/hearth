import type { Nudge } from "@hearth/shared"
import { create } from "zustand"

export interface IncomingNudge extends Nudge {
  /** Nothing about a nudge is unique, so the banner re-keys on this. */
  id: number
}

interface NudgeState {
  current: IncomingNudge | null
  receive(nudge: Nudge): void
  dismiss(): void
}

let counter = 0
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Holds the one message that is on screen right now and then forgets it. There
 * is no history behind this, by design.
 *
 * A second message replaces the first instead of queueing. The newest one is
 * the one that matters, and a queue would make someone sit through a backlog.
 */
export const useNudgeStore = create<NudgeState>()((set) => ({
  current: null,
  receive: (message) => {
    if (timer) clearTimeout(timer)
    counter += 1
    set({ current: { ...message, id: counter } })
    // Longer than a toast: these are someone else's words rather than a
    // confirmation of your own action, and they cannot be read again anywhere.
    timer = setTimeout(() => set({ current: null }), 5_000)
  },
  dismiss: () => {
    if (timer) clearTimeout(timer)
    set({ current: null })
  },
}))
