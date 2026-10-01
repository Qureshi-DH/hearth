import { auditIp, describeAuditEntry } from "../audit"
import { Empty, Loading, Problem } from "../components/ui"
import { ago, dateTime } from "../format"
import { useNow } from "../hooks"
import { useAudit } from "../queries"

export function Activity() {
  const audit = useAudit()
  const now = useNow()
  return (
    <section className="section">
      <p className="lede muted">
        Every change made from this portal or the app's admin screen, every sign-in to this portal,
        and every session the server ended because a sign-in token turned up twice.
      </p>
      {audit.isPending ? <Loading /> : null}
      {audit.error ? <Problem error={audit.error} /> : null}
      {audit.data && audit.data.length === 0 ? <Empty title="Nothing yet" /> : null}
      <ol className="timeline">
        {audit.data?.map((entry) => {
          const ip = auditIp(entry)
          return (
            <li
              key={entry.id}
              className={entry.action === "session.refresh_reuse" ? "flagged" : undefined}
            >
              <p>{describeAuditEntry(entry)}</p>
              <p className="muted small">
                <time dateTime={entry.createdAt} title={dateTime(entry.createdAt)}>
                  {ago(entry.createdAt, now)}
                </time>
                {ip ? ` from ${ip}` : ""}
              </p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
