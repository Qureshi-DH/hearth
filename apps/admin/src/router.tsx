import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react"

import { BASE } from "./base"

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

/**
 * The page an address shows. The base comes off when it is there, so the
 * portal opened on the server's own port, past the proxy, still finds its page.
 */
export function pageAt(pathname: string, base: string): PagePath {
  const inside =
    base && (pathname === base || pathname.startsWith(`${base}/`))
      ? pathname.slice(base.length)
      : pathname
  const path = inside.replace(/\/+$/, "") || "/"
  return path in PAGES ? (path as PagePath) : "/"
}

/**
 * The overview ends in a slash under a path, because a proxy matching
 * /hearth/* does not match /hearth, and a reload has to find the server.
 */
export function hrefFor(page: PagePath, base: string): string {
  return page === "/" ? `${base}/` : `${base}${page}`
}

function current(): PagePath {
  return pageAt(window.location.pathname, BASE)
}

/** An address with no page of its own shows the overview, so the address bar says so too. */
function settle(): PagePath {
  const path = current()
  const href = hrefFor(path, BASE)
  if (window.location.pathname !== href) {
    window.history.replaceState(null, "", `${href}${window.location.search}${window.location.hash}`)
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
  window.history.pushState(null, "", hrefFor(path, BASE))
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
  return <a {...props} href={hrefFor(to, BASE)} onClick={onClick} />
}
