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

export const useToastStore = create<ToastState>()((set) => ({
  current: null,
  show: (message, tone = "neutral") => {
    if (timer) clearTimeout(timer)
    counter += 1
    set({ current: { id: counter, message, tone } })
    timer = setTimeout(() => set({ current: null }), 2600)
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
