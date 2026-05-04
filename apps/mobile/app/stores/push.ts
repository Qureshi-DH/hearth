import { create } from "zustand"

import type { PushSetupResult } from "@/services/notifications"

interface PushState {
  setup: PushSetupResult | null
  setSetup: (setup: PushSetupResult | null) => void
}

/**
 * setupPush runs once per session and its answer is the only explanation the
 * user ever gets for why alerts do or do not arrive, so it has to outlive the
 * call that produced it.
 */
export const usePushStore = create<PushState>()((set) => ({
  setup: null,
  setSetup: (setup) => set({ setup }),
}))
