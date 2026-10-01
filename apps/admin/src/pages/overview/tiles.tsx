import { Sparkline } from "../../components/charts"
import { changeOnYesterday, statusOf } from "../../dashboard"
import { count, plural } from "../../format"
import { PUSH_PROVIDER_LABEL } from "../../labels"
import { OVERVIEW_EVERY_MS, useServerInfo, useStats, type OverviewQuery } from "../../queries"
import { Tile } from "./parts"

export function PeopleTile({ overview }: { overview: OverviewQuery }) {
  const stats = useStats({ every: OVERVIEW_EVERY_MS })
  const status = statusOf(stats, overview)
  const today = overview.data?.activeAccounts.at(-1) ?? 0
  return (
    <Tile
      icon="people"
      label="People"
      status={status}
      value={stats.data ? count(stats.data.users) : null}
      foot={`${plural(today, "person", "people")} sent a fix today`}
    >
      {overview.data ? (
        <Sparkline values={overview.data.activeAccounts} label="People sending fixes, each day" />
      ) : null}
    </Tile>
  )
}

export function FixesTile({ overview }: { overview: OverviewQuery }) {
  const status = statusOf(overview)
  if (!overview.data) return <Tile icon="location" label="Fixes today" status={status} />
  const { fixes } = overview.data
  const today = fixes.at(-1) ?? 0
  const change = changeOnYesterday(today, fixes.at(-2) ?? 0)
  return (
    <Tile
      icon="location"
      label="Fixes today"
      status={status}
      value={count(today)}
      foot={change.text}
      tone={change.tone === "flat" ? undefined : change.tone}
    >
      <Sparkline values={fixes} label="Location fixes, each day" />
    </Tile>
  )
}

export function NotificationsTile({ overview }: { overview: OverviewQuery }) {
  const info = useServerInfo()
  const status = statusOf(overview, info)
  if (!overview.data || !info.data) {
    return <Tile icon="notifications" label="Notifications today" status={status} />
  }
  const { notifications } = overview.data
  const sent = notifications.sent.at(-1) ?? 0
  const failed = notifications.failed.at(-1) ?? 0
  const provider = info.data.pushProvider
  let foot = `Sent through ${PUSH_PROVIDER_LABEL[provider]}`
  let tone: "warning" | "danger" | undefined
  if (failed > 0) {
    foot = `${count(failed)} failed today`
    tone = "danger"
  } else if (provider === "none") {
    foot = "No push provider, so none go out"
    tone = "warning"
  }
  return (
    <Tile
      icon="notifications"
      label="Notifications today"
      status={status}
      value={count(sent)}
      foot={foot}
      tone={tone}
    >
      <Sparkline values={notifications.sent.slice(-7)} label="Notifications sent, each day" />
    </Tile>
  )
}
