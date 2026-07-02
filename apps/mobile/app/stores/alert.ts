import { create } from "zustand"

export interface AlertButton {
  text: string
  onPress?: () => void
  /** Same meaning as the system alert: cancel is the safe way out, destructive is red. */
  style?: "default" | "cancel" | "destructive"
}

export interface AlertRequest {
  id: number
  title: string
  message?: string
  buttons: AlertButton[]
}

interface AlertState {
  current: AlertRequest | null
  queue: AlertRequest[]
  show(request: Omit<AlertRequest, "id">): void
  /** Ends the current alert and brings up the next one waiting, if any. */
  dismiss(): void
}

let counter = 0

export const useAlertStore = create<AlertState>()((set, get) => ({
  current: null,
  queue: [],
  show: (request) => {
    counter += 1
    const next = { ...request, id: counter }
    if (get().current) set((state) => ({ queue: [...state.queue, next] }))
    else set({ current: next })
  },
  dismiss: () => {
    const [head, ...rest] = get().queue
    set({ current: head ?? null, queue: rest })
  },
}))

/**
 * Same call shape as the system Alert.alert, drawn by AlertHost in the app's
 * own theme. No buttons means a single OK.
 */
export function alert(title: string, message?: string, buttons?: AlertButton[]): void {
  useAlertStore.getState().show({ title, message, buttons: buttons ?? [] })
}
