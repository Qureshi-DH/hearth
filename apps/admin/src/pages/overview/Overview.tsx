import { useQueryClient } from "@tanstack/react-query"

import { Icon } from "../../components/icons"
import { Problem } from "../../components/ui"
import { ago } from "../../format"
import { useNow } from "../../hooks"
import { OVERVIEW_EVERY_MS, useChecks, useOverview, useStats } from "../../queries"
import {
  ActivityWidget,
  ChangesWidget,
  HealthWidget,
  NotificationsWidget,
  ServerWidget,
} from "./panels"
import { PhonesTile, PhonesWidget } from "./phones"
import { FixesTile, NotificationsTile, PeopleTile } from "./tiles"

export function Overview() {
  const overview = useOverview()
  const now = useNow()

  return (
    <div className="dash">
      <PeopleTile overview={overview} />
      <PhonesTile overview={overview} />
      <FixesTile overview={overview} />
      <NotificationsTile overview={overview} />
      {overview.error ? (
        <div className="span-12">
          <Problem error={overview.error} />
        </div>
      ) : null}
      <ActivityWidget overview={overview} />
      <HealthWidget />
      <PhonesWidget overview={overview} now={now} />
      <NotificationsWidget overview={overview} />
      <ChangesWidget now={now} />
      <ServerWidget />
    </div>
  )
}

/** The page header's corner: when the numbers were read, and a way to read them again. */
export function OverviewRefresh() {
  const queryClient = useQueryClient()
  const overview = useOverview()
  const stats = useStats({ every: OVERVIEW_EVERY_MS })
  const checks = useChecks()
  const now = useNow(15_000)
  const fetching = overview.isFetching || stats.isFetching || checks.isFetching
  const stalled = overview.isError || stats.isError || checks.isError
  const updated = overview.dataUpdatedAt
  return (
    <div className="refresh">
      <span className={`refresh-live${stalled ? " refresh-stalled" : ""}`} aria-hidden="true" />
      <span className={`refresh-text muted small${stalled ? " is-stalled" : ""}`}>
        {stalled
          ? "Not updating"
          : updated
            ? `Updated ${ago(new Date(updated).toISOString(), now)}`
            : "Loading"}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Refresh"
        title="Refresh"
        aria-busy={fetching || undefined}
        onClick={() => {
          // A press while a refetch is under way would only start it over.
          if (fetching) return
          for (const key of ["overview", "stats", "checks", "audit"]) {
            void queryClient.invalidateQueries({ queryKey: [key] })
          }
        }}
      >
        <span className={fetching ? "spinning" : undefined}>
          <Icon name="refresh" size={16} />
        </span>
      </button>
    </div>
  )
}
