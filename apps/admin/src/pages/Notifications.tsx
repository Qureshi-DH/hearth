import type { AdminOutboxEntry } from "@hearth/shared"
import { useState } from "react"

import { client } from "../client"
import { Badge, Button, Card, Empty, Loading, Problem, useToast } from "../components/ui"
import { ago, count } from "../format"
import { OUTBOX_EVERY_MS, useAdminAction, useOutbox, useStats } from "../queries"

const FILTERS: Array<{ value: AdminOutboxEntry["status"] | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Waiting" },
  { value: "failed", label: "Failed" },
  { value: "sent", label: "Sent" },
  { value: "skipped", label: "Skipped" },
]

const STATUS: Record<
  AdminOutboxEntry["status"],
  { label: string; tone: "neutral" | "good" | "warning" | "danger" }
> = {
  pending: { label: "Waiting", tone: "warning" },
  sending: { label: "Sending", tone: "warning" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
}

const CHANNEL: Record<AdminOutboxEntry["channel"], string> = {
  default: "Update",
  alerts: "Alert",
  sos: "SOS",
}

export function Notifications({ myId }: { myId: string }) {
  const toast = useToast()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all")
  const outbox = useOutbox(filter)
  // The queue's count is polled with the table, or the two disagree.
  const stats = useStats({ every: OUTBOX_EVERY_MS })

  const drain = useAdminAction(
    () =>
      client.request<{ sent: number; skipped: number; failed: number }>("/admin/push/drain", {
        method: "POST",
      }),
    ["outbox"],
  )
  const test = useAdminAction(() => client.request("/push/test", { method: "POST" }), ["outbox"])

  return (
    <>
      <section className="section">
        <Card className="toolbar-card">
          <div>
            <p className="stat-label">Waiting to go out</p>
            <p className="stat-value">{stats.data ? count(stats.data.pushQueueDepth) : "…"}</p>
          </div>
          <div className="actions">
            <Button
              busy={drain.isPending}
              onClick={async () => {
                try {
                  const result = await drain.mutateAsync(undefined)
                  toast(
                    `Sent ${result.sent}, skipped ${result.skipped}, failed ${result.failed}.`,
                    result.failed > 0 ? "danger" : "good",
                  )
                } catch {
                  toast("The queue could not be sent.", "danger")
                }
              }}
            >
              Send waiting now
            </Button>
            <Button
              busy={test.isPending}
              onClick={async () => {
                try {
                  await test.mutateAsync(undefined)
                  toast("A test notification is on its way to your own devices.")
                } catch {
                  toast("The test could not be queued.", "danger")
                }
              }}
            >
              Send me a test
            </Button>
          </div>
        </Card>
        <p className="muted small">
          Only your own notifications show their words. Everybody else's alerts say where they
          arrived or what was said to them, and running the server is not being in their circle.
        </p>
      </section>

      <section className="section">
        <div className="segmented" role="group" aria-label="Filter by status">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              className={filter === option.value ? "active" : undefined}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {outbox.isPending ? <Loading /> : null}
        {outbox.error ? <Problem error={outbox.error} /> : null}
        {outbox.data && outbox.data.length === 0 ? <Empty title="Nothing here" /> : null}
        {outbox.data && outbox.data.length > 0 ? (
          <div
            className={`table-wrap${outbox.isPlaceholderData ? " is-stale" : ""}`}
            aria-busy={outbox.isPlaceholderData || undefined}
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>To</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {outbox.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>{ago(entry.createdAt)}</td>
                    <td>{entry.userName ?? "A removed account"}</td>
                    <td>{CHANNEL[entry.channel]}</td>
                    <td>
                      <Badge tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</Badge>
                      {entry.attempts > 1 ? (
                        <span className="muted small"> {entry.attempts} tries</span>
                      ) : null}
                    </td>
                    <td className="detail">
                      {entry.lastError ? (
                        <span className="error-text">{entry.lastError}</span>
                      ) : entry.userId === myId && entry.title ? (
                        <span>
                          <strong>{entry.title}</strong> {entry.body}
                        </span>
                      ) : (
                        <span className="muted">Words hidden</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  )
}
