import { create } from "zustand"

export interface Toast {
  id: number
  message: string
  tone: "neutral" | "success" | "error"
}

interface ToastState {
  current: Toast | null
  show(message: string, tone?: Toast["tone"]): void
  dismiss(): void
}

let counter = 0
let timer: ReturnType<typeof setTimeout> | null = null

// About as fast as somebody reads a line they did not expect. An error is
// often the only word on why something failed, so it gets a longer floor,
// and a tap still dismisses any toast early.
const MS_PER_CHARACTER = 60
const FLOOR_MS = { neutral: 2600, success: 2600, error: 6000 }
const CEILING_MS = 15_000

export function toastDuration(message: string, tone: Toast["tone"]): number {
  return Math.min(CEILING_MS, Math.max(FLOOR_MS[tone], message.length * MS_PER_CHARACTER))
}

export const useToastStore = create<ToastState>()((set) => ({
  current: null,
  show: (message, tone = "neutral") => {
    if (timer) clearTimeout(timer)
    counter += 1
    set({ current: { id: counter, message, tone } })
    timer = setTimeout(() => set({ current: null }), toastDuration(message, tone))
  },
  dismiss: () => {
    if (timer) clearTimeout(timer)
    set({ current: null })
  },
}))

export const toast = {
  show: (message: string) => useToastStore.getState().show(message, "neutral"),
  success: (message: string) => useToastStore.getState().show(message, "success"),
  error: (message: string) => useToastStore.getState().show(message, "error"),
  info: (message: string) => useToastStore.getState().show(message, "neutral"),
}
