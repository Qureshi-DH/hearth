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
    // A button tapped again while its alert is still on its way only wants
    // the one alert. On iOS that wait used to last until a modal screen closed.
    const same = (other: AlertRequest | null) =>
      !!other && other.title === request.title && other.message === request.message
    const { current, queue } = get()
    if (same(current) || queue.some(same)) return
    counter += 1
    const next = { ...request, id: counter }
    if (current) set({ queue: [...queue, next] })
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
