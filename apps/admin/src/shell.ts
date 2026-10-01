import { createContext, useContext, useEffect } from "react"

/** Set by a page that covers the whole window, so the sidebar behind it is out of Tab's reach. */
export const ShellCover = createContext<(covered: boolean) => void>(() => {})

export function useCoverShell(covered: boolean) {
  const cover = useContext(ShellCover)
  useEffect(() => {
    if (!covered) return
    cover(true)
    return () => cover(false)
  }, [covered, cover])
}
