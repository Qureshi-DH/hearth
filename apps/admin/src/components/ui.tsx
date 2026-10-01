import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react"

import { ApiError, UNREACHABLE } from "../api"

/**
 * A busy button stays enabled and ignores presses, and so does one given
 * aria-disabled. Disabling it would drop focus to the page, and a keyboard
 * user would lose their place.
 */
export function Button({
  tone = "secondary",
  busy = false,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "quiet"
  busy?: boolean
}) {
  const refused = busy || String(props["aria-disabled"]) === "true"
  return (
    <button
      type="button"
      {...props}
      className={`button button-${tone} ${props.className ?? ""}`}
      aria-disabled={refused || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        // Cancelling the click also stops a submit button sending its form.
        if (refused) event.preventDefault()
        else onClick?.(event)
      }}
    />
  )
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "good" | "warning" | "danger"
  children: ReactNode
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function Avatar({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?"
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  )
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  )
}

/** The server's own words, or ours in place of them where `wording` has some for its code. */
export function Problem({
  error,
  wording,
}: {
  error: unknown
  wording?: Partial<Record<string, string>>
}) {
  const message = error instanceof ApiError ? (wording?.[error.code] ?? error.message) : UNREACHABLE
  return (
    <p className="problem" role="alert">
      {message}
    </p>
  )
}

/**
 * The browser's own modal dialog, so focus stays inside it and Escape closes
 * it without any of that being rebuilt here. Focus goes back to whatever
 * opened it, including when the dialog is unmounted while still open, which
 * the browser would otherwise leave on the page body. When the opener is gone
 * or cannot take focus, it goes to `fallbackFocus` instead.
 */
export function Dialog({
  open,
  title,
  onClose,
  fallbackFocus,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  fallbackFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog || !open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const fallback = fallbackFocus?.current
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      opener?.focus()
      if (!opener || document.activeElement !== opener) fallback?.focus()
    }
  }, [open, fallbackFocus])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="dialog-body">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {children}
        </div>
      ) : null}
    </dialog>
  )
}

/** Asks before anything that signs somebody out or takes access away. */
export function Confirm({
  open,
  title,
  body,
  action,
  tone = "danger",
  busy,
  error,
  fallbackFocus,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: ReactNode
  action: string
  tone?: "primary" | "danger"
  busy?: boolean
  error?: unknown
  fallbackFocus?: RefObject<HTMLElement | null>
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open={open} title={title} onClose={onCancel} fallbackFocus={fallbackFocus}>
      <div className="dialog-text">{body}</div>
      {error ? <Problem error={error} /> : null}
      <div className="dialog-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button tone={tone} busy={busy} onClick={onConfirm}>
          {action}
        </Button>
      </div>
    </Dialog>
  )
}

interface Toast {
  id: number
  text: string
  tone: "good" | "danger"
}

const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const show = useCallback((text: string, tone: Toast["tone"] = "good") => {
    const id = next.current++
    setToasts((current) => [...current, { id, text, tone }])
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      5000,
    )
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}
