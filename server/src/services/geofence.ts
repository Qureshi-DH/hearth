import { DEFAULTS, haversineMeters, pathDistanceMeters, type FeedEvent } from "@hearth/shared"
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import {
  circleMembers,
  locationPoints,
  placeEvents,
  placeMemberships,
  places,
  users,
} from "../db/schema"
import { broadcastEvent, recordEvent } from "./feed"
import { outingGroup } from "./notification-groups"
import {
  DEFAULT_READER,
  LATE_AFTER_MS,
  PLACE_NEWS_CATCH_UP_MS,
  wordPlaceNews,
  type Journey,
  type Wording,
} from "./place-news"
import { OUTBOX_CHANNEL } from "./push"

/**
 * Two crossings of one fence this close together in one upload cancel out.
 * Driving through a fence puts one fix inside and the next one back outside.
 */
const TRANSIENT_VISIT_MS = 2 * 60 * 1000

/**
 * How long a crossing stays open to being undone by the next fix. A car
 * passing a school is out the far side well inside it, and so is a phone
 * whose Wi-Fi fix jumped down the street and came back.
 */
const SETTLE_MS = 60 * 1000

/**
 * How long a departure waits on a phone that says it has not moved. One fix
 * of it outside a place is the phone's word against itself, so it waits for
 * a second fix to agree, a parked phone's next report or two, and goes late
 * if none comes.
 */
const STILL_LEAVE_HOLD_MS = 45 * 60 * 1000

/** Faster than anybody runs. An arrival at this pace may be a car going past. */
const DRIVE_PAST_MPS = 5

/** Coming back to a place this soon after leaving it is pacing its boundary. */
const REENTRY_MS = 10 * 60 * 1000

/** And keeps the place to the feed for this long after each such return. */
const QUIET_AFTER_RETURN_MS = 15 * 60 * 1000

/** A departure further back than this did not start the journey an arrival ends. */
const MAX_JOURNEY_MS = 3 * 60 * 60 * 1000

/** A fix a second for three hours, so the read stays bounded. */
const MAX_JOURNEY_FIXES = 12_000

/**
 * How far back the fence looks to work out which of a user's devices is the one
 * they are carrying. An hour is long enough that the walk to school is still
 * visible once they are sitting in the classroom, and short enough that a phone
 * left in a drawer yesterday has stopped counting as a traveller.
 */
const CARRIER_LOOKBACK_MS = DEFAULTS.offlineAfterSeconds * 1000

/**
 * Ground a device has to have covered before it counts as having gone
 * somewhere. Below this it is furniture wandering inside its own error circle.
 * The floor is the shortest walk that can take somebody from the middle of the
 * smallest fence to properly outside it, so nothing a real crossing needs is
 * dismissed as jitter.
 */
const CARRIED_DISPLACEMENT_METERS =
  DEFAULTS.minPlaceRadiusMeters + DEFAULTS.geofenceExitBufferMeters

export interface GeofenceFix {
  lat: number
  lon: number
  accuracyMeters?: number | null
  recordedAt: Date
  pointId?: number | null
  speedMps?: number | null
  /** The phone's own word on what it was doing, "still" for one that has not moved. */
  activity?: string | null
}

/** How far one device wandered over the lookback, as a corner-to-corner span. */
interface DeviceTravel {
  deviceId: string
  metres: number
}

/**
 * One membership row per (place, user) is the whole of what the family is told,
 * but a person can have a phone in their pocket and a tablet on the charger,
 * and both upload. Something has to decide which of them the family is being
 * told about, or the two take turns overturning each other and the circle gets
 * an arrive and a leave for every upload, for as long as both keep reporting.
 *
 * The answer is the one that is physically true: a person takes their phone
 * with them, so of the devices still reporting, the fence follows whichever has
 * actually been somewhere. A tablet on a kitchen table has been nowhere, so it
 * has nothing to say about where its owner is. It still records history and
 * still moves the map, it just does not move fences.
 *
 * Deciding by position instead was the mistake this replaces: whether a device
 * disagrees says nothing about which of them is right, so it silenced the real
 * departure and the real arrival exactly as readily as the spurious ones.
 */
function carriedDevice(travel: DeviceTravel[]): string | null {
  let best: DeviceTravel | null = null
  let tied = false
  for (const device of travel) {
    if (device.metres < CARRIED_DISPLACEMENT_METERS) continue
    if (!best || device.metres > best.metres) {
      best = device
      tied = false
    } else if (device.metres === best.metres) {
      tied = true
    }
  }
  // Two devices that travelled the same distance are two devices the fence
  // cannot choose between, and a coin toss between them is the ping-pong again.
  return tied ? null : (best?.deviceId ?? null)
}

export interface GeofenceTransition {
  placeId: string
  placeName: string
  circleId: string
  type: "arrive" | "leave"
  occurredAt: Date
  pointId: number | null
}

interface Crossing extends GeofenceTransition {
  /** Where the fix that made it sits in the batch. */
  fixIndex: number
  /** How far that fix was from the place's centre. */
  metres: number
  radiusMeters: number
}

type PlaceRow = {
  id: string
  circleId: string
  name: string
  lat: number
  lon: number
  radiusMeters: number
}

/**
 * A fix is a circle, not a point. A crossing counts only once half the error
 * circle is clear of the boundary, so a coarse fix can still decide a wide
 * fence but never a doorstep one. Anything less certain keeps the state it
 * already had, which is the honest answer and the only one the exit buffer is
 * narrow enough to absorb.
 *
 * Half the error circle, not all of it. Shrinking the fence by the whole
 * radius means a fix even slightly coarser than the fence can never enter it,
 * and never entering means never leaving either, so an ordinary indoor blend
 * would freeze a small place for good.
 *
 * A network estimate may bring somebody into a place wide enough for it, but
 * takes them out of one only from further than it strays. A night of cell
 * fixes a street away had a phone on the nightstand leave home twice. Twice
 * its error is past where nearly all of them fall, and still close enough to
 * see a phone that really left.
 */
function judge(place: PlaceRow, fix: GeofenceFix, wasInside: boolean) {
  const metres = haversineMeters({ lat: fix.lat, lon: fix.lon }, { lat: place.lat, lon: place.lon })
  const accuracy = fix.accuracyMeters ?? 0
  const margin = accuracy / 2
  const exitMargin = accuracy > DEFAULTS.coarseFixAccuracyMeters ? 2 * accuracy : margin
  const clear = metres - exitMargin > place.radiusMeters + DEFAULTS.geofenceExitBufferMeters
  const isInside = wasInside ? !clear : metres + margin <= place.radiusMeters
  return { isInside, clear, metres }
}

/**
 * Places and current membership load once and fold over in memory, so a
 * catch-up upload costs a constant number of queries rather than four per
 * point.
 *
 * Several safeguards keep this from spamming the family. Fixes worse than
 * `geofenceMaxAccuracyMeters` are dropped outright, because a 2 km cell-tower
 * fix would "arrive" everywhere at once, and every fix that survives still has
 * to clear the boundary by half its own error circle before it may change
 * anything. Leaving requires clearing the radius plus a buffer, so a phone
 * resting on a boundary cannot oscillate. A pair of crossings closer together
 * than a visit takes cancels out, so driving through a fence says nothing. And
 * when an account has more than one device reporting, only the one that has
 * actually travelled may move a fence at all.
 *
 * That last rule is the one that holds across uploads, and it has to, because a
 * moving phone flushes every fix as its own request and the tablet at home
 * flushes on its own schedule in between.
 *
 * What the family hears is narrower still, a departure once it is real and an
 * arrival as soon as it is, carrying the journey.
 */
export async function evaluateGeofenceBatch(
  db: Database,
  userId: string,
  fixes: GeofenceFix[],
  options: {
    /**
     * Circles allowed to learn about arrivals and departures. A member sharing
     * "approximate" or "paused" with a circle must not have that circle told
     * they just reached a specific address. That is the point of those modes.
     */
    visibleCircleIds?: string[]
    /** Wall clock, so a replayed backlog can be told apart from live movement. */
    now?: Date
  } = {},
): Promise<GeofenceTransition[]> {
  const now = options.now ?? new Date()
  const usable = fixes
    .filter(
      (fix) =>
        fix.accuracyMeters == null || fix.accuracyMeters <= DEFAULTS.geofenceMaxAccuracyMeters,
    )
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())

  if (usable.length === 0) return []

  const visible = options.visibleCircleIds
  if (visible && visible.length === 0) return []

  // The membership join is what keeps a caller from writing arrivals into a
  // circle this user does not belong to. Joining it here also spares the
  // upload path a second read of the rows it already has.
  const placeRows: PlaceRow[] = await db
    .select({
      id: places.id,
      circleId: places.circleId,
      name: places.name,
      lat: places.lat,
      lon: places.lon,
      radiusMeters: places.radiusMeters,
    })
    .from(places)
    .innerJoin(
      circleMembers,
      and(eq(circleMembers.circleId, places.circleId), eq(circleMembers.userId, userId)),
    )
    .where(visible ? inArray(places.circleId, visible) : undefined)
  if (placeRows.length === 0) return []

  const lastFixAt = usable[usable.length - 1]!.recordedAt
  const transitions: Crossing[] = []

  // Which device a fix came from is a property of the stored point rather than
  // of the batch. It is read back here instead of widened into `GeofenceFix`
  // because the fence also has to see the devices that did not upload, and
  // those are never in the batch.
  const pointIds = usable.map((fix) => fix.pointId).filter((id): id is number => id != null)
  const batchDevices = new Set<string>()
  if (pointIds.length > 0) {
    const rows = await db
      .select({ deviceId: locationPoints.deviceId })
      .from(locationPoints)
      .where(and(eq(locationPoints.userId, userId), inArray(locationPoints.id, pointIds)))
    for (const row of rows) if (row.deviceId) batchDevices.add(row.deviceId)
  }

  if (batchDevices.size > 0) {
    // One row per device however many fixes they have between them, and the
    // corners of where each has been rather than the track itself, because all
    // the fence needs is how far each of them got from where it started.
    const from = new Date(usable[0]!.recordedAt.getTime() - CARRIER_LOOKBACK_MS)
    const rows = (await db.execute(sql`
      select device_id,
             min(lat) as min_lat, max(lat) as max_lat,
             min(lon) as min_lon, max(lon) as max_lon
      from location_points
      where user_id = ${userId}::uuid
        and device_id is not null
        and recorded_at >= ${from.toISOString()}::timestamptz
        and recorded_at <= ${lastFixAt.toISOString()}::timestamptz
        and (accuracy_meters is null or accuracy_meters <= ${DEFAULTS.geofenceMaxAccuracyMeters})
      group by device_id
    `)) as unknown as Array<{
      device_id: string
      min_lat: number
      max_lat: number
      min_lon: number
      max_lon: number
    }>

    // One device reporting is the ordinary case and needs no arbitration: there
    // is nobody to argue with, so whatever it says is the best the fence has.
    if (rows.length > 1) {
      const travel = rows.map((row) => ({
        deviceId: row.device_id,
        metres: haversineMeters(
          { lat: row.min_lat, lon: row.min_lon },
          { lat: row.max_lat, lon: row.max_lon },
        ),
      }))
      const carrier = carriedDevice(travel)
      // Nothing here is thrown away. The points are already stored, presence
      // already moved, and the fence picks the argument up again on the next
      // upload from whichever device turns out to be the one being carried.
      if (!carrier || !batchDevices.has(carrier)) return []
    }
  }

  // The speed a fix shows, from the phone or from the fix before it in the
  // batch, whichever says faster.
  const speedAt = (index: number) => {
    const fix = usable[index]!
    let speed = fix.speedMps ?? 0
    const previous = usable[index - 1]
    if (previous) {
      const seconds = (fix.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000
      if (seconds > 0 && seconds <= 120)
        speed = Math.max(speed, haversineMeters(previous, fix) / seconds)
    }
    return speed
  }

  const broadcasts: Array<{ circleId: string; event: FeedEvent }> = []

  // The new state and the events it produced commit together. If
  // `lastEvaluatedAt` moved on its own and the process then died, every fix in
  // this batch would be skipped as a straggler on the retry, and the arrival
  // nobody was told about could never be recovered.
  await db.transaction(async (tx) => {
    // One person's two signed-in devices can upload at the same moment. The
    // membership read below is what decides the transitions, so without
    // serialising here both uploads see "outside" and both announce the same
    // arrival. Blocking rather than skipping, because the batch that loses the
    // race still has fixes that have to be evaluated.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hearth:geofence:${userId}`}))`)

    const existing = await tx
      .select()
      .from(placeMemberships)
      .where(
        and(
          eq(placeMemberships.userId, userId),
          inArray(
            placeMemberships.placeId,
            placeRows.map((place) => place.id),
          ),
        ),
      )
    const rowFor = new Map(existing.map((row) => [row.placeId, row]))

    // When each place was last left, if recently enough that coming back to
    // it would be pacing its boundary.
    const recentlyLeft = new Map(
      (
        await tx
          .select({
            placeId: placeEvents.placeId,
            at: sql<string | Date>`max(${placeEvents.occurredAt})`,
          })
          .from(placeEvents)
          .where(
            and(
              eq(placeEvents.userId, userId),
              eq(placeEvents.type, "leave"),
              inArray(
                placeEvents.placeId,
                placeRows.map((place) => place.id),
              ),
              gte(placeEvents.occurredAt, new Date(usable[0]!.recordedAt.getTime() - REENTRY_MS)),
            ),
          )
          .groupBy(placeEvents.placeId)
      ).map((row) => [row.placeId, new Date(row.at).getTime()]),
    )

    const writes = new Map<
      string,
      { isInside: boolean; since: Date; settlesAt: Date | null; quietUntil: Date | null }
    >()
    const standing = new Set<Crossing>()
    /** Crossings the feed keeps and the family is not told about. */
    const silent = new Set<Crossing>()
    /** How long each standing crossing's push waits to see whether it holds. */
    const holdMs = new Map<Crossing, number>()
    /** Returns from a departure inside this batch, which was never sent either. */
    const returns = new Map<Crossing, Crossing>()
    const cancel: Array<{ placeId: string; type: "place_arrive" | "place_leave"; why: string }> = []
    const release: Array<{ placeId: string; type: "place_arrive" | "place_leave" }> = []

    for (const place of placeRows) {
      const row = rowFor.get(place.id)
      const evaluatedUntil = row?.lastEvaluatedAt.getTime() ?? -Infinity
      let wasInside = row?.isInside ?? false
      let since: Date | null = null
      let firstEvaluation = !row
      const crossings: Crossing[] = []

      for (const [index, fix] of usable.entries()) {
        // A straggler older than what this fence has already seen cannot rewind
        // its state. Skipping it is what makes retried uploads idempotent here.
        if (fix.recordedAt.getTime() <= evaluatedUntil) continue

        const { isInside, metres } = judge(place, fix, wasInside)
        if (isInside === wasInside && !firstEvaluation) continue

        // The first evaluation only counts as an event if they are inside.
        // "Not at the park" is not news.
        const shouldEmit = !firstEvaluation || isInside
        firstEvaluation = false
        wasInside = isInside
        since = fix.recordedAt

        if (!shouldEmit) continue

        crossings.push({
          placeId: place.id,
          placeName: place.name,
          circleId: place.circleId,
          type: isInside ? "arrive" : "leave",
          occurredAt: fix.recordedAt,
          pointId: fix.pointId ?? null,
          fixIndex: index,
          metres,
          radiusMeters: place.radiusMeters,
        })
      }

      // Crossings for one fence always alternate, so a pair closer together
      // than a transit takes cancels out. Dropping both halves leaves the
      // membership exactly where it started, which is where the person is.
      const kept: Crossing[] = []
      for (const crossing of crossings) {
        const previous = kept[kept.length - 1]
        if (
          previous &&
          crossing.occurredAt.getTime() - previous.occurredAt.getTime() < TRANSIENT_VISIT_MS
        ) {
          kept.pop()
          continue
        }
        kept.push(crossing)
      }
      transitions.push(...kept)

      let settlesAt = row?.settlesAt ?? null
      let quietUntil = row?.quietUntil ?? null
      const open = settlesAt != null && settlesAt.getTime() > now.getTime()

      // The crossing an earlier upload left open, undone before its push went.
      // That is a departure the phone came straight back from, or an arrival
      // at speed that drove on out. Neither half is news, and the held push goes too.
      // Once that push has gone, the family was told, so the crossing back is
      // news and goes out like any other.
      const first = kept[0]
      if (open && first) {
        silent.add(first)
        cancel.push(
          first.type === "arrive"
            ? { placeId: place.id, type: "place_leave", why: "came straight back before it went" }
            : {
                placeId: place.id,
                type: "place_arrive",
                why: "drove straight through before it went",
              },
        )
      }

      // Somebody pacing a boundary leaves and comes back every few minutes,
      // and a pair for every lap teaches a family to ignore the app. After a
      // return that soon, the place goes quiet for a while. The return itself
      // is sent, because the family was told they had left.
      let leftAt = row && !row.isInside ? (recentlyLeft.get(place.id) ?? null) : null
      for (const [index, crossing] of kept.entries()) {
        const at = crossing.occurredAt.getTime()
        if (quietUntil && at < quietUntil.getTime()) silent.add(crossing)
        if (crossing.type === "leave") {
          leftAt = at
          continue
        }
        const previous = kept[index - 1]
        if (previous) returns.set(crossing, previous)
        const cameBack = !(open && index === 0) && leftAt !== null && at - leftAt < REENTRY_MS
        if (cameBack) {
          const until = at + QUIET_AFTER_RETURN_MS
          if (!quietUntil || until > quietUntil.getTime()) quietUntil = new Date(until)
        }
        leftAt = null
      }

      const last = kept[kept.length - 1]
      if (last && last.type === (wasInside ? "arrive" : "leave")) {
        // Everything before it was overturned by a later fix in the same
        // batch, so it is history the moment it is written.
        standing.add(last)
        const covered = lastFixAt.getTime() - last.occurredAt.getTime()
        let hold = 0
        if (!silent.has(last)) {
          if (last.type === "leave") {
            // A departure stands once a second fix is clear of the place too,
            // or once a minute has passed with no fix back inside. One Wi-Fi
            // fix that jumps past the buffer is otherwise "left Home" and a
            // minute later "arrived at Home".
            const agreed = usable
              .slice(last.fixIndex + 1)
              .some((fix) => judge(place, fix, false).clear)
            const still =
              usable[last.fixIndex]!.activity === "still" && speedAt(last.fixIndex) < DRIVE_PAST_MPS
            const confirmed = agreed || (!still && covered >= SETTLE_MS)
            hold = confirmed ? 0 : still ? STILL_LEAVE_HOLD_MS : SETTLE_MS - covered
          } else if (speedAt(last.fixIndex) >= DRIVE_PAST_MPS) {
            // An arrival at walking pace is an arrival. At driving speed it
            // may be a car passing, which is out the far side well inside a
            // minute, so only that one waits.
            hold = Math.max(0, SETTLE_MS - covered)
          }
        }
        holdMs.set(last, hold)
        settlesAt = hold > 0 ? new Date(now.getTime() + hold) : null
      } else if (open && row && kept.length === 0) {
        // Nothing crossed, so the open crossing either held or is still open.
        // A departure held on a still phone's word waits for a fix outside to
        // agree, not for the time to pass.
        const covered = lastFixAt.getTime() - row.since.getTime()
        const heldStill =
          !row.isInside && row.settlesAt!.getTime() - row.since.getTime() > 2 * SETTLE_MS
        const confirmed =
          (!heldStill && covered >= SETTLE_MS) ||
          (!row.isInside &&
            usable.some((fix) => fix.recordedAt > row.since && judge(place, fix, false).clear))
        if (confirmed) {
          release.push({ placeId: place.id, type: row.isInside ? "place_arrive" : "place_leave" })
          settlesAt = null
        }
      }

      const changed = wasInside !== (row?.isInside ?? false)
      if (
        changed ||
        !row ||
        settlesAt?.getTime() !== row.settlesAt?.getTime() ||
        quietUntil?.getTime() !== row.quietUntil?.getTime()
      ) {
        writes.set(place.id, {
          isInside: wasInside,
          since: changed || !row ? (since ?? lastFixAt) : row.since,
          settlesAt,
          quietUntil,
        })
      }
    }

    const untouched = placeRows
      .map((place) => place.id)
      .filter(
        (id) =>
          !writes.has(id) &&
          rowFor.has(id) &&
          rowFor.get(id)!.lastEvaluatedAt.getTime() < lastFixAt.getTime(),
      )

    for (const [placeId, state] of writes) {
      await tx
        .insert(placeMemberships)
        .values({ placeId, userId, ...state, lastEvaluatedAt: lastFixAt })
        .onConflictDoUpdate({
          target: [placeMemberships.placeId, placeMemberships.userId],
          set: {
            ...state,
            // Forward only. The straggler guard above is what makes an
            // out-of-order upload safe, and rewinding this watermark hands
            // those already-judged fixes back to the fence.
            lastEvaluatedAt: sql`greatest(${placeMemberships.lastEvaluatedAt}, excluded.last_evaluated_at)`,
          },
        })
    }

    if (untouched.length > 0) {
      await tx
        .update(placeMemberships)
        .set({
          lastEvaluatedAt: sql`greatest(${placeMemberships.lastEvaluatedAt}, ${lastFixAt.toISOString()}::timestamptz)`,
        })
        .where(
          and(eq(placeMemberships.userId, userId), inArray(placeMemberships.placeId, untouched)),
        )
    }

    for (const held of cancel) {
      await tx.execute(sql`
        update notification_outbox
        set status = 'skipped', sent_at = ${now.toISOString()}::timestamptz, last_error = ${held.why}
        where status = 'pending'
          and data ->> 'type' = ${held.type}
          and data ->> 'placeId' = ${held.placeId}
          and data ->> 'userId' = ${userId}
      `)
    }
    for (const held of release) {
      await tx.execute(sql`
        update notification_outbox
        set next_attempt_at = ${now.toISOString()}::timestamptz
        where status = 'pending'
          and data ->> 'type' = ${held.type}
          and data ->> 'placeId' = ${held.placeId}
          and data ->> 'userId' = ${userId}
          and next_attempt_at > ${now.toISOString()}::timestamptz
      `)
    }
    // The outbox wakes its drain on an insert, and this is an update.
    if (release.length > 0) await tx.execute(sql`select pg_notify(${OUTBOX_CHANNEL}, '')`)

    if (transitions.length === 0) return

    // In the order they happened, departures first at the same instant, so
    // the feed reads the way the day went.
    transitions.sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        (a.type === b.type ? 0 : a.type === "leave" ? -1 : 1),
    )

    // A departure inside this batch was never sent, since the return
    // overturned it. Coming straight back from it is no news either, unless
    // they arrived somewhere else on the way.
    for (const [arrival, departure] of returns) {
      const wentSomewhere = transitions.some(
        (other) =>
          other.circleId === arrival.circleId &&
          other.type === "arrive" &&
          other.placeId !== arrival.placeId &&
          other.occurredAt > departure.occurredAt &&
          other.occurredAt < arrival.occurredAt,
      )
      if (!wentSomewhere) silent.add(arrival)
    }

    await tx.insert(placeEvents).values(
      transitions.map((transition) => ({
        placeId: transition.placeId,
        circleId: transition.circleId,
        userId,
        type: transition.type,
        occurredAt: transition.occurredAt,
        pointId: transition.pointId,
      })),
    )

    const [actor] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const name = actor?.displayName ?? "Someone"

    // A backlog uploaded after an outage replays crossings that really
    // happened, days ago. They belong in the feed, but pushing them now would
    // tell the family someone is at the park while they are at work. What
    // decides that is whether the batch still describes the present, not how
    // old the crossing inside it is: a phone Doze sat on for twenty minutes
    // flushes an arrival the person is still standing in, and the same
    // transaction writes them a presence row that says exactly that.
    const batchIsLive = now.getTime() - lastFixAt.getTime() < DEFAULTS.staleAfterSeconds * 1000
    const worthPushing = (transition: Crossing) =>
      batchIsLive &&
      standing.has(transition) &&
      !silent.has(transition) &&
      now.getTime() - transition.occurredAt.getTime() < PLACE_NEWS_CATCH_UP_MS

    // Walking into a Home inside a Town crosses both on the same fix. The
    // family hears about the one the fix is most specifically at.
    const atOnce = new Map<string, Crossing[]>()
    for (const transition of transitions.filter(worthPushing)) {
      const key = `${transition.circleId}|${transition.type}|${transition.occurredAt.getTime()}`
      atOnce.set(key, [...(atOnce.get(key) ?? []), transition])
    }
    for (const group of atOnce.values()) {
      const [chosen] = [...group].sort(
        (a, b) =>
          a.radiusMeters - b.radiusMeters ||
          a.metres - b.metres ||
          (a.placeId < b.placeId ? -1 : 1),
      )
      for (const other of group) if (other !== chosen) silent.add(other)
    }

    // A departure and the arrival it led to, in one upload, are one piece of
    // news. The departure waits for the arrival, and the drain folds it in
    // when the arrival goes. Were the arrival undone as a drive-past, the
    // departure still goes then.
    const holdUntilArrival = (departure: Crossing) =>
      Math.max(
        0,
        ...transitions
          .filter(
            (arrival) =>
              arrival.type === "arrive" &&
              arrival.circleId === departure.circleId &&
              arrival.placeId !== departure.placeId &&
              arrival.occurredAt >= departure.occurredAt &&
              worthPushing(arrival),
          )
          .map((arrival) => holdMs.get(arrival) ?? 0),
      )

    for (const transition of transitions) {
      const verb = transition.type === "arrive" ? "arrived at" : "left"
      const push = worthPushing(transition)
      const hold = Math.max(
        holdMs.get(transition) ?? 0,
        transition.type === "leave" ? holdUntilArrival(transition) : 0,
      )
      let notify: Parameters<typeof recordEvent>[1]["notify"]
      if (push) {
        const wording: Wording = {
          who: name,
          kind: transition.type,
          place: transition.placeName,
          journey:
            transition.type === "arrive"
              ? await journeyTo(tx as unknown as Database, userId, transition)
              : null,
          at: transition.occurredAt.toISOString(),
          lateAfter: new Date(transition.occurredAt.getTime() + LATE_AFTER_MS).toISOString(),
        }
        // Worded as it happened. The drain words it again for each reader as
        // it goes, late or not.
        const { body, line } = wordPlaceNews(wording, DEFAULT_READER, transition.occurredAt)
        notify = {
          title: transition.placeName,
          body,
          group: outingGroup(userId, name, line),
          notBefore: hold > 0 ? new Date(now.getTime() + hold) : undefined,
          data: {
            placeId: transition.placeId,
            userId,
            occurredAt: transition.occurredAt.toISOString(),
            wording,
          },
        }
      }
      const dto = await recordEvent(tx as unknown as Database, {
        deferBroadcast: true,
        circleId: transition.circleId,
        type: transition.type === "arrive" ? "place_arrive" : "place_leave",
        actorUserId: userId,
        occurredAt: transition.occurredAt,
        payload: {
          placeId: transition.placeId,
          placeName: transition.placeName,
          occurredAt: transition.occurredAt.toISOString(),
        },
        summary: `${name} ${verb} ${transition.placeName}`,
        notify,
      })
      broadcasts.push({ circleId: transition.circleId, event: dto })
    }
  })

  for (const { circleId, event } of broadcasts) {
    await broadcastEvent(circleId, event)
  }

  return transitions.map(
    ({ placeId, placeName, circleId, type, occurredAt, pointId }): GeofenceTransition => ({
      placeId,
      placeName,
      circleId,
      type,
      occurredAt,
      pointId,
    }),
  )
}

/**
 * The journey an arrival ends, worked out from the fixes since the departure
 * it answers, so the arrival can say how far and how long and no separate
 * notification for the trip is needed. The newest crossing before it in the
 * same circle decides. Another arrival means they were already somewhere, and
 * a departure is where the journey began.
 */
async function journeyTo(db: Database, userId: string, arrival: Crossing): Promise<Journey | null> {
  const rows = await db
    .select({
      type: placeEvents.type,
      placeId: placeEvents.placeId,
      occurredAt: placeEvents.occurredAt,
      pointId: placeEvents.pointId,
      name: places.name,
      radiusMeters: places.radiusMeters,
    })
    .from(placeEvents)
    .innerJoin(places, eq(places.id, placeEvents.placeId))
    .where(
      and(
        eq(placeEvents.userId, userId),
        eq(placeEvents.circleId, arrival.circleId),
        gte(placeEvents.occurredAt, new Date(arrival.occurredAt.getTime() - MAX_JOURNEY_MS)),
        lte(placeEvents.occurredAt, arrival.occurredAt),
      ),
    )
    .orderBy(desc(placeEvents.occurredAt), desc(placeEvents.id))
    .limit(20)

  // Other places entered on the same fix are this arrival, not a stop on the way.
  const before = rows.filter(
    (row) => !(row.type === "arrive" && row.occurredAt.getTime() === arrival.occurredAt.getTime()),
  )
  const latest = before[0]
  if (!latest || latest.type !== "leave") return null
  const [origin] = before
    .filter(
      (row) => row.type === "leave" && row.occurredAt.getTime() === latest.occurredAt.getTime(),
    )
    .sort((a, b) => a.radiusMeters - b.radiusMeters || (a.placeId < b.placeId ? -1 : 1))
  if (!origin || origin.placeId === arrival.placeId) return null

  // How far they went is precise information about the whole way, so a
  // circle that was shown less than that for part of it is told nothing.
  const [member] = await db
    .select({ preciseSince: circleMembers.preciseSince })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, arrival.circleId), eq(circleMembers.userId, userId)))
    .limit(1)
  if (member?.preciseSince && member.preciseSince > origin.occurredAt) return null

  const [device] = arrival.pointId
    ? await db
        .select({ deviceId: locationPoints.deviceId })
        .from(locationPoints)
        .where(eq(locationPoints.id, arrival.pointId))
        .limit(1)
    : []
  const sameTrack = and(
    eq(locationPoints.userId, userId),
    device?.deviceId ? eq(locationPoints.deviceId, device.deviceId) : undefined,
    or(
      isNull(locationPoints.accuracyMeters),
      lte(locationPoints.accuracyMeters, DEFAULTS.coarseFixAccuracyMeters),
    ),
  )
  const point = { lat: locationPoints.lat, lon: locationPoints.lon }
  // Where they set out from is the last fix at the origin, however long the
  // phone sat quietly there first.
  const [start] = await db
    .select(point)
    .from(locationPoints)
    .where(and(sameTrack, lt(locationPoints.recordedAt, origin.occurredAt)))
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1)
  const path = await db
    .select(point)
    .from(locationPoints)
    .where(
      and(
        sameTrack,
        gte(locationPoints.recordedAt, origin.occurredAt),
        lte(locationPoints.recordedAt, arrival.occurredAt),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(MAX_JOURNEY_FIXES)

  return {
    from: origin.name,
    meters: Math.round(pathDistanceMeters(start ? [start, ...path] : path)),
    // A phone that left and arrived on the same fix said nothing on the way,
    // so nothing says when it set off.
    seconds:
      origin.occurredAt.getTime() === arrival.occurredAt.getTime() ||
      (origin.pointId != null && origin.pointId === arrival.pointId)
        ? null
        : (arrival.occurredAt.getTime() - origin.occurredAt.getTime()) / 1000,
  }
}

/**
 * Without this, everyone already standing inside a new place fires a spurious
 * "arrived" on their next fix.
 *
 * The two rules below are the same ones `evaluateGeofenceBatch` applies, and
 * they have to be, because this is the one path that can write "inside" without
 * the fence ever seeing the fix. A 2 km cell-tower fix that happens to sit on
 * the family's street would otherwise seed a 150 m fence the engine itself
 * would refuse to decide, and the next honest fix then reads as a departure
 * from a place the member was never in.
 *
 * A fix too coarse to decide seeds no row at all rather than an explicit
 * "outside". Leaving the row out keeps the watermark out of the way too, so the
 * first fix good enough to judge the fence gets to judge it from scratch.
 */
export async function primePlaceMemberships(db: Database, placeId: string): Promise<void> {
  await db.execute(sql`
    insert into place_memberships (place_id, user_id, is_inside, since, last_evaluated_at)
    select
      p.id,
      cm.user_id,
      -- Haversine, inlined: runs once per place creation, not per fix. Half the
      -- error circle has to clear the boundary, exactly as it does per fix.
      (2 * 6371008.8 * asin(sqrt(
        power(sin(radians(up.lat - p.lat) / 2), 2) +
        cos(radians(p.lat)) * cos(radians(up.lat)) *
        power(sin(radians(up.lon - p.lon) / 2), 2)
      ))) + coalesce(up.accuracy_meters, 0) / 2 <= p.radius_meters,
      -- Both stamps come from the fix this decision was made on. A watermark
      -- stamped in the present would make every fix already in flight look
      -- like a straggler, so the fence would ignore the next real crossing.
      coalesce(up.recorded_at, now()),
      coalesce(up.recorded_at, now())
    from places p
    join circle_members cm on cm.circle_id = p.circle_id
    join user_presence up on up.user_id = cm.user_id
    where p.id = ${placeId}
      and up.lat is not null
      and up.lon is not null
      and (
        up.accuracy_meters is null
        or up.accuracy_meters <= ${DEFAULTS.geofenceMaxAccuracyMeters}
      )
    on conflict (place_id, user_id) do nothing
  `)
}

/**
 * Starts one member's fences for these circles from where they are now, and
 * tells nobody. While they shared approximately with a circle, or paused it,
 * the fence said nothing to that circle and kept no track of them there, so
 * its rows describe wherever they were when that began. Picking up from those
 * would announce a departure hours old as if it had just happened.
 *
 * The newest fix sharp enough for the fence decides, by the same rule as a
 * new place is seeded with. With none at all the rows go, and the first fix
 * that can decide does so from scratch.
 */
export async function reseedPlaceMemberships(
  db: Database,
  userId: string,
  circleIds: string[],
): Promise<void> {
  if (circleIds.length === 0) return
  const circlePlaces = await db
    .select({
      id: places.id,
      lat: places.lat,
      lon: places.lon,
      radiusMeters: places.radiusMeters,
    })
    .from(places)
    .where(inArray(places.circleId, circleIds))
  if (circlePlaces.length === 0) return

  const [fix] = await db
    .select({
      lat: locationPoints.lat,
      lon: locationPoints.lon,
      accuracyMeters: locationPoints.accuracyMeters,
      recordedAt: locationPoints.recordedAt,
    })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        or(
          isNull(locationPoints.accuracyMeters),
          lte(locationPoints.accuracyMeters, DEFAULTS.geofenceMaxAccuracyMeters),
        ),
      ),
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1)

  if (!fix) {
    await db.delete(placeMemberships).where(
      and(
        eq(placeMemberships.userId, userId),
        inArray(
          placeMemberships.placeId,
          circlePlaces.map((place) => place.id),
        ),
      ),
    )
    return
  }

  const margin = (fix.accuracyMeters ?? 0) / 2
  await db
    .insert(placeMemberships)
    .values(
      circlePlaces.map((place) => ({
        placeId: place.id,
        userId,
        isInside: haversineMeters(fix, place) + margin <= place.radiusMeters,
        since: fix.recordedAt,
        lastEvaluatedAt: fix.recordedAt,
        settlesAt: null,
        quietUntil: null,
      })),
    )
    .onConflictDoUpdate({
      target: [placeMemberships.placeId, placeMemberships.userId],
      set: {
        isInside: sql`excluded.is_inside`,
        // Still at home after a pause at home is still at home since this
        // morning, which is what the map says under their name.
        since: sql`case when ${placeMemberships.isInside} = excluded.is_inside
          then ${placeMemberships.since} else excluded.since end`,
        lastEvaluatedAt: sql`greatest(${placeMemberships.lastEvaluatedAt}, excluded.last_evaluated_at)`,
        settlesAt: null,
        quietUntil: null,
      },
    })
}
