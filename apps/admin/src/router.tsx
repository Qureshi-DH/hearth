import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react"

export const PAGES = {
  "/": "Overview",
  "/accounts": "Accounts",
  "/circles": "Circles",
  "/settings": "Settings",
  "/notifications": "Notifications",
  "/activity": "Activity",
  "/account": "Your account",
} as const

export type PagePath = keyof typeof PAGES

const NAVIGATE = "hearth:navigate"

function current(): PagePath {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  return path in PAGES ? (path as PagePath) : "/"
}

/** An address with no page of its own shows the overview, so the address bar says "/" too. */
function settle(): PagePath {
  const path = current()
  if (window.location.pathname !== path) {
    window.history.replaceState(null, "", `${path}${window.location.search}${window.location.hash}`)
  }
  return path
}

export function usePath(): PagePath {
  const [path, setPath] = useState(current)
  useEffect(() => {
    const update = () => setPath(settle())
    update()
    window.addEventListener("popstate", update)
    window.addEventListener(NAVIGATE, update)
    return () => {
      window.removeEventListener("popstate", update)
      window.removeEventListener(NAVIGATE, update)
    }
  }, [])
  return path
}

function navigate(path: PagePath) {
  if (path === current()) return
  window.history.pushState(null, "", path)
  window.dispatchEvent(new Event(NAVIGATE))
  window.scrollTo(0, 0)
}

/** A real link, so a middle click still opens a tab, that navigates in place otherwise. */
export function Link({ to, ...props }: { to: PagePath } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event)
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return <a {...props} href={to} onClick={onClick} />
}
