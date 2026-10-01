import type { AdminCheck } from "@hearth/shared"
import { useState, type ReactNode } from "react"

import { describeAuditEntry } from "../../audit"
import { Columns } from "../../components/charts"
import { Icon, type IconName } from "../../components/icons"
import { Badge, Problem } from "../../components/ui"
import { statusOf } from "../../dashboard"
import { ago, bytes, count, date, dateTime, duration, plural } from "../../format"
import { PUSH_PROVIDER_LABEL, SIGN_UP_LABEL } from "../../labels"
import {
  OVERVIEW_EVERY_MS,
  useAudit,
  useChecks,
  useServerInfo,
  useStats,
  type OverviewQuery,
} from "../../queries"
import { Failed, MoreLink, Skeleton, sum, Widget } from "./parts"

const LEVEL_ORDER: AdminCheck["level"][] = ["warning", "info", "ok"]
const LEVEL_ICON: Record<AdminCheck["level"], IconName> = {
  warning: "warning",
  info: "info",
  ok: "check",
}

export function ActivityWidget({ overview }: { overview: OverviewQuery }) {
  const [showing, setShowing] = useState<"fixes" | "people">("fixes")
  const status = statusOf(overview)
  const toggle = (
    <div className="segmented segmented-small" role="group" aria-label="What to chart">
      <button
        type="button"
        className={showing === "fixes" ? "active" : ""}
        aria-pressed={showing === "fixes"}
        onClick={() => setShowing("fixes")}
      >
        Fixes
      </button>
      <button
        type="button"
        className={showing === "people" ? "active" : ""}
        aria-pressed={showing === "people"}
        onClick={() => setShowing("people")}
      >
        People
      </button>
    </div>
  )

  let body: ReactNode
  if (!overview.data) {
    body =
      status === "failed" ? (
        <Failed className="panel-failed" />
      ) : (
        <>
          <p className="widget-summary">
            <Skeleton wide />
          </p>
          <div className="chart-skeleton" />
        </>
      )
  } else {
    const { days, fixes, activeAccounts } = overview.data
    const total = sum(fixes)
    const busiest = Math.max(...activeAccounts)
    body = (
      <>
        <p className="widget-summary">
          {showing === "fixes"
            ? `${plural(total, "fix", "fixes")}, about ${count(Math.round(total / days.length))} a day`
            : `Up to ${plural(busiest, "person", "people")} sending fixes on one day`}
        </p>
        <Columns
          label={showing === "fixes" ? "Fixes each day" : "People sending fixes each day"}
          days={days}
          series={[
            {
              key: showing,
              label: showing === "fixes" ? "Fixes" : "People",
              values: showing === "fixes" ? fixes : activeAccounts,
            },
          ]}
          unit={(n) =>
            showing === "fixes" ? plural(n, "fix", "fixes") : plural(n, "person", "people")
          }
          empty="Nothing reported in the last two weeks"
        />
      </>
    )
  }
  return (
    <Widget title="Activity, last 14 days" span={8} action={toggle}>
      {body}
    </Widget>
  )
}

export function HealthWidget() {
  const checks = useChecks()
  const ordered = [...(checks.data ?? [])].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
  )
  const warnings = ordered.filter((check) => check.level === "warning").length
  return (
    <Widget
      title="Health"
      span={4}
      action={
        checks.data ? (
          <Badge tone={warnings > 0 ? "warning" : "good"}>
            {warnings > 0 ? `${warnings} to fix` : "All good"}
          </Badge>
        ) : null
      }
    >
      {checks.error ? <Problem error={checks.error} /> : null}
      {!checks.data && !checks.error ? <div className="list-skeleton" /> : null}
      <ul className="health">
        {ordered.map((check) => (
          <li key={check.id} className={`health-item level-${check.level}`}>
            <span className="health-icon">
              <Icon name={LEVEL_ICON[check.level]} size={16} />
            </span>
            <div>
              <p className="health-title">{check.title}</p>
              {check.level !== "ok" ? <p className="health-detail">{check.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </Widget>
  )
}

const OUTCOMES = [
  { key: "sent", label: "Sent" },
  { key: "waiting", label: "Waiting" },
  { key: "skipped", label: "Skipped" },
  { key: "failed", label: "Failed" },
] as const

export function NotificationsWidget({ overview }: { overview: OverviewQuery }) {
  const status = statusOf(overview)
  const days = overview.data?.days.slice(-7) ?? []
  const series = OUTCOMES.map((outcome) => ({
    ...outcome,
    values: overview.data?.notifications[outcome.key].slice(-7) ?? [],
  }))
  return (
    <Widget
      title="Notifications, last 7 days"
      span={4}
      action={<MoreLink to="/notifications">Queue</MoreLink>}
    >
      {status === "failed" ? (
        <Failed className="panel-failed" />
      ) : (
        <>
          <ul className="legend">
            {series.map((s) => (
              <li key={s.key}>
                <span className={`legend-dot part-${s.key}`} aria-hidden="true" />
                <span className="legend-label">{s.label}</span>
                <span className="legend-value">
                  {status === "ready" ? count(sum(s.values)) : <Skeleton />}
                </span>
              </li>
            ))}
          </ul>
          {status === "ready" ? (
            <Columns
              label="Notifications each day"
              days={days}
              series={series}
              unit={(n) => plural(n, "notification")}
              empty="No notifications this week"
            />
          ) : (
            <div className="chart-skeleton" />
          )}
        </>
      )}
    </Widget>
  )
}

export function ChangesWidget({ now }: { now: number }) {
  const audit = useAudit()
  const recent = (audit.data ?? []).slice(0, 6)
  return (
    <Widget
      title="Recent changes"
      span={8}
      action={<MoreLink to="/activity">All activity</MoreLink>}
    >
      {audit.error ? <Problem error={audit.error} /> : null}
      {!audit.data && !audit.error ? <div className="list-skeleton" /> : null}
      {audit.data && recent.length === 0 ? (
        <p className="muted">
          Nothing yet. Changes made here and in the app's admin screen show up here.
        </p>
      ) : null}
      <ol className="changes">
        {recent.map((entry) => (
          <li
            key={entry.id}
            className={entry.action === "session.refresh_reuse" ? "flagged" : undefined}
          >
            <p>{describeAuditEntry(entry)}</p>
            <time
              className="muted small"
              dateTime={entry.createdAt}
              title={dateTime(entry.createdAt)}
            >
              {ago(entry.createdAt, now)}
            </time>
          </li>
        ))}
      </ol>
    </Widget>
  )
}

export function ServerWidget() {
  const stats = useStats({ every: OVERVIEW_EVERY_MS })
  const info = useServerInfo()
  const facts: Array<[string, ReactNode]> = stats.data
    ? [
        [
          "Version",
          `Hearth ${stats.data.version}${info.data ? `, API ${info.data.apiVersion}` : ""}`,
        ],
        ["Running for", duration(stats.data.uptimeSeconds)],
        ["Database", bytes(stats.data.databaseSizeBytes)],
        [
          "History",
          stats.data.oldestPointAt
            ? `${count(stats.data.locationPoints)} fixes since ${date(stats.data.oldestPointAt)}`
            : "No fixes yet",
        ],
        [
          "Circles",
          `${plural(stats.data.circles, "circle")}, ${plural(stats.data.places, "place")}`,
        ],
        ["Push", PUSH_PROVIDER_LABEL[stats.data.pushProvider]],
        ["Sign-up", info.data ? SIGN_UP_LABEL[info.data.registrationMode] : ""],
      ]
    : []
  return (
    <Widget title="Server" span={4} action={<MoreLink to="/settings">Settings</MoreLink>}>
      {stats.error ? <Problem error={stats.error} /> : null}
      {!stats.data && !stats.error ? <div className="list-skeleton" /> : null}
      <dl className="server-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Widget>
  )
}
