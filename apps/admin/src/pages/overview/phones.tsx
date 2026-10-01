import type { AdminPhone, AdminPhoneState } from "@hearth/shared"

import { Avatar } from "../../components/ui"
import { phonesSummary, sortPhones, statusOf } from "../../dashboard"
import { ago, dateTime } from "../../format"
import { ISSUE_LABEL, PHONE_STATE_LABEL, PLATFORM_LABEL } from "../../labels"
import type { OverviewQuery } from "../../queries"
import { Failed, MoreLink, Tile, Widget } from "./parts"

/** The meter's order, from the phones doing their job to the ones that stopped. */
const METER: AdminPhoneState[] = ["reporting", "quiet", "parked", "never", "offline"]

export function PhonesTile({ overview }: { overview: OverviewQuery }) {
  const status = statusOf(overview)
  if (!overview.data) return <Tile icon="phone" label="Phones heard from" status={status} />
  const { heard, total, tally, foot, tone } = phonesSummary(overview.data.phones)
  return (
    <Tile
      icon="phone"
      label="Phones heard from"
      status={status}
      value={
        <>
          {heard}
          <span className="tile-of"> of {total}</span>
        </>
      }
      foot={foot}
      tone={tone}
    >
      {total > 0 ? (
        <span className="meter" role="img" aria-label={`${heard} of ${total} phones heard from`}>
          {METER.map((state) =>
            tally[state] > 0 ? (
              <span
                key={state}
                className={`meter-part state-${state}`}
                style={{ flexGrow: tally[state] }}
              />
            ) : null,
          )}
        </span>
      ) : null}
    </Tile>
  )
}

export function PhonesWidget({ overview, now }: { overview: OverviewQuery; now: number }) {
  const status = statusOf(overview)
  const rows = sortPhones(overview.data?.phones ?? [])
  return (
    <Widget title="Phones" span={8} action={<MoreLink to="/accounts">Accounts</MoreLink>}>
      {status === "loading" ? <div className="list-skeleton" /> : null}
      {status === "failed" ? <Failed className="panel-failed" /> : null}
      {status === "ready" && rows.length === 0 ? <p className="muted">No accounts yet.</p> : null}
      {rows.length > 0 ? (
        <div className="table-wrap flush">
          <table className="table phones">
            <thead>
              <tr>
                <th>Person</th>
                <th>Phone</th>
                <th>Last heard</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((phone) => (
                <PhoneRow key={phone.userId} phone={phone} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Widget>
  )
}

function PhoneRow({ phone, now }: { phone: AdminPhone; now: number }) {
  const model = phone.platform ? PLATFORM_LABEL[phone.platform] : null
  return (
    <tr>
      <td>
        <div className="person">
          <Avatar name={phone.displayName} color={phone.avatarColor} size={30} />
          <div className="person-text">
            <p className="person-name">{phone.displayName}</p>
            {phone.issues.length > 0 ? (
              <ul className="phone-issues">
                {phone.issues.map((issue) => (
                  <li key={issue}>{ISSUE_LABEL[issue]}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </td>
      <td>
        {model ? (
          <>
            <p className="cell-main">{phone.deviceName ?? model}</p>
            <p className="muted small">
              {model}
              {phone.appVersion ? `, Hearth ${phone.appVersion}` : ""}
            </p>
          </>
        ) : (
          <p className="muted">None signed in</p>
        )}
      </td>
      <td>
        {phone.lastHeardAt ? (
          <time dateTime={phone.lastHeardAt} title={dateTime(phone.lastHeardAt)}>
            {ago(phone.lastHeardAt, now)}
          </time>
        ) : (
          <span className="muted">Never</span>
        )}
      </td>
      <td>
        <span className={`state state-${phone.state}`}>
          <span className="state-dot" aria-hidden="true" />
          {PHONE_STATE_LABEL[phone.state]}
        </span>
      </td>
    </tr>
  )
}
