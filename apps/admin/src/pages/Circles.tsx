import type { AdminCircleSummary } from "@hearth/shared"

import { Badge, Card, Empty, Loading, Problem } from "../components/ui"
import { date, plural } from "../format"
import { useCircles } from "../queries"

export function Circles() {
  const circles = useCircles()
  return (
    <section className="section">
      <p className="lede muted">
        Who is in each circle and how it is set up. Where anybody is stays with the people they
        share it with, so none of that is here.
      </p>
      {circles.isPending ? <Loading /> : null}
      {circles.error ? <Problem error={circles.error} /> : null}
      {circles.data && circles.data.length === 0 ? (
        <Empty title="No circles yet">Families create them in the Hearth app.</Empty>
      ) : null}
      <div className="circles">
        {circles.data?.map((circle) => (
          <CircleCard key={circle.id} circle={circle} />
        ))}
      </div>
    </section>
  )
}

function CircleCard({ circle }: { circle: AdminCircleSummary }) {
  const { settings } = circle
  return (
    <Card>
      <h2 className="circle-name">
        {circle.emoji ? <span aria-hidden="true">{circle.emoji}</span> : null} {circle.name}
      </h2>
      <p className="muted small">
        Created {date(circle.createdAt)}, {plural(circle.memberCount, "member")},{" "}
        {plural(circle.placeCount, "place")}
      </p>
      <ul className="members">
        {circle.members.map((member) => (
          <li key={member.userId}>
            {member.displayName}
            {member.role !== "member" ? (
              <Badge tone={member.role === "owner" ? "accent" : "neutral"}>
                {member.role === "owner" ? "Owner" : "Admin"}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
      <ul className="chips">
        <li>
          {settings.allowHistory
            ? `History kept ${plural(settings.historyRetentionDays, "day")}`
            : "History off, live position only"}
        </li>
        <li>{settings.allowSharingPause ? "Pausing allowed" : "Pausing off"}</li>
        <li>
          {settings.speedAlertKmh > 0
            ? `Speed alert at ${settings.speedAlertKmh} km/h`
            : "No speed alert"}
        </li>
        <li>{settings.incidentDetection ? "Crash detection on" : "Crash detection off"}</li>
      </ul>
    </Card>
  )
}
