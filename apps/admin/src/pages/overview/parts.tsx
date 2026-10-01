import type { ReactNode } from "react"

import { Icon, type IconName } from "../../components/icons"
import type { Status } from "../../dashboard"
import { Link, type PagePath } from "../../router"

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

export const Skeleton = ({ wide = false }: { wide?: boolean }) => (
  <span className={`skeleton${wide ? " skeleton-wide" : ""}`} aria-hidden="true" />
)

/** Said in place of a tile's number or a panel's contents when the request for it failed. */
export function Failed({ className = "" }: { className?: string }) {
  return (
    <p className={`failed ${className}`}>
      <Icon name="warning" size={15} />
      Could not load
    </p>
  )
}

export function Tile({
  icon,
  label,
  status,
  value,
  foot,
  tone,
  children,
}: {
  icon: IconName
  label: string
  status: Status
  value?: ReactNode
  foot?: ReactNode
  tone?: "good" | "warning" | "danger" | "up" | "down"
  children?: ReactNode
}) {
  return (
    <section className="tile" aria-busy={status === "loading" || undefined}>
      <header className="tile-head">
        <span className="tile-icon">
          <Icon name={icon} size={16} />
        </span>
        <h2 className="tile-label">{label}</h2>
      </header>
      {status === "failed" ? (
        <Failed className="tile-failed" />
      ) : (
        <>
          <p className="tile-value">{status === "loading" ? <Skeleton /> : value}</p>
          <p className={`tile-foot${tone && status === "ready" ? ` tone-${tone}` : ""}`}>
            {status === "loading" ? <Skeleton wide /> : foot}
          </p>
          {status === "ready" ? children : null}
        </>
      )}
    </section>
  )
}

export function Widget({
  title,
  span,
  action,
  children,
}: {
  title: string
  span: 4 | 8 | 12
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`widget span-${span}`}>
      <header className="widget-head">
        <h2 className="widget-title">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

export function MoreLink({ to, children }: { to: PagePath; children: ReactNode }) {
  return (
    <Link to={to} className="more-link">
      {children}
      <Icon name="arrow" size={14} />
    </Link>
  )
}
