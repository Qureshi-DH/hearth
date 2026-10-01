import { DEFAULTS, haversineMeters, type FeedEvent } from "@hearth/shared"
import { and, eq, inArray, sql } from "drizzle-orm"

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

/**
 * A crossing cancelled this quickly was a transit, not a visit. Driving through
 * a fence puts one fix inside and the next one back outside, and an arrival the
 * family is told about and then told to forget is worse than no arrival at all.
 */
const TRANSIENT_VISIT_MS = 2 * 60 * 1000

/**
 * How late an arrival may land and still be worth waking someone for. Doze, a
 * tunnel or a flat cell can hold an upload back for half an hour, and "they got
 * to school" is still the news when it finally arrives. Older than this and it
 * has turned into history, which belongs in the feed and nowhere else.
 */
const ALERT_CATCH_UP_MS = 30 * 60 * 1000

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
  const placeRows = await db
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
  const transitions: GeofenceTransition[] = []

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

    const known = new Map(existing.map((row) => [row.placeId, row.isInside]))
    const seenBefore = new Set(existing.map((row) => row.placeId))
    const evaluatedUntil = new Map(
      existing.map((row) => [row.placeId, row.lastEvaluatedAt.getTime()]),
    )
    // When each fence was entered, so a leave that lands in a later upload can
    // still recognise a transit. The within-batch fold below only sees pairs
    // that arrived together, and a moving phone uploads each fix on its own.
    const insideSince = new Map(
      existing.filter((row) => row.isInside).map((row) => [row.placeId, row.since.getTime()]),
    )

    const finalState = new Map<string, { isInside: boolean; since: Date }>()
    const standingCrossings = new Set<GeofenceTransition>()
    /** Entries an upload later turned out to be a drive-past. */
    const transits: Array<{ placeId: string; leave: GeofenceTransition }> = []

    for (const place of placeRows) {
      let wasInside = known.get(place.id) ?? false
      let since: Date | null = null
      let firstEvaluation = !seenBefore.has(place.id)
      const crossings: GeofenceTransition[] = []

      for (const fix of usable) {
        // A straggler older than what this fence has already seen cannot rewind
        // its state. Skipping it is what makes retried uploads idempotent here.
        if (fix.recordedAt.getTime() <= (evaluatedUntil.get(place.id) ?? -Infinity)) continue

        const distance = haversineMeters(
          { lat: fix.lat, lon: fix.lon },
          { lat: place.lat, lon: place.lon },
        )
        // A fix is a circle, not a point. A crossing counts only once half the
        // error circle is clear of the boundary, so a coarse fix can still
        // decide a wide fence but never a doorstep one. Anything less certain
        // than that keeps the state it already had, which is the honest answer
        // and the only one the exit buffer is narrow enough to absorb.
        // Half the error circle, not all of it. Shrinking the fence by the
        // whole radius means a fix even slightly coarser than the fence can
        // never enter it, and never entering means never leaving either, so an
        // ordinary indoor blend would freeze a small place for good. Half still
        // refuses a fix far too vague to decide the fence at all.
        const accuracy = fix.accuracyMeters ?? 0
        const margin = accuracy / 2
        // A network estimate may bring somebody into a place wide enough for
        // it, but takes them out of one only from further than it strays: a
        // night of cell fixes a street away had a phone on the nightstand
        // leave home twice. Twice its error is past where nearly all of them
        // fall, and still close enough to see a phone that really left.
        const exitMargin = accuracy > DEFAULTS.coarseFixAccuracyMeters ? 2 * accuracy : margin
        const isInside = wasInside
          ? distance - exitMargin <= place.radiusMeters + DEFAULTS.geofenceExitBufferMeters
          : distance + margin <= place.radiusMeters

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
        })
      }

      // Crossings for one fence always alternate, so a pair closer together
      // than a transit takes cancels out. Dropping both halves leaves the
      // membership exactly where it started, which is where the person is.
      const kept: GeofenceTransition[] = []
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

      // A leave that cancels an entry from an earlier upload. The fold above
      // can only pair crossings that arrived together, and a phone in motion
      // uploads each fix as it gets it, so without this the same drive past a
      // school is a transit in one request and an arrival in three.
      const enteredAt = insideSince.get(place.id)
      const first = kept[0]
      if (
        first &&
        first.type === "leave" &&
        enteredAt !== undefined &&
        first.occurredAt.getTime() - enteredAt < TRANSIENT_VISIT_MS
      ) {
        transits.push({ placeId: place.id, leave: first })
      }

      transitions.push(...kept)

      // The crossing this batch ends on, and only if it agrees with the state
      // being written. Everything before it has already been overturned by a
      // later fix in the same batch, so it is history the moment it is written.
      const last = kept[kept.length - 1]
      if (last && last.type === (wasInside ? "arrive" : "leave")) {
        standingCrossings.add(last)
      }

      const changed = wasInside !== (known.get(place.id) ?? false)
      if (changed || !seenBefore.has(place.id)) {
        finalState.set(place.id, { isInside: wasInside, since: since ?? lastFixAt })
      }
    }

    const untouched = placeRows
      .map((place) => place.id)
      .filter(
        (id) =>
          !finalState.has(id) &&
          seenBefore.has(id) &&
          (evaluatedUntil.get(id) ?? -Infinity) < lastFixAt.getTime(),
      )

    for (const [placeId, state] of finalState) {
      await tx
        .insert(placeMemberships)
        .values({
          placeId,
          userId,
          isInside: state.isInside,
          since: state.since,
          lastEvaluatedAt: lastFixAt,
        })
        .onConflictDoUpdate({
          target: [placeMemberships.placeId, placeMemberships.userId],
          set: {
            isInside: state.isInside,
            since: state.since,
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

    if (transitions.length === 0) return

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

    // Cancel the buzz for an entry this batch has just shown to be a drive-past,
    // and say nothing about the leave either. The feed keeps both rows, because
    // they are what the fixes say and a reader can see the two together, but a
    // phone that buzzes "arrived at School" and then "left School" a minute
    // later is how a family learns to ignore the app.
    const transited = new Set(transits.map((t) => t.leave))
    for (const transit of transits) {
      await tx.execute(sql`
        update notification_outbox
        set status = 'skipped'
        where status = 'pending'
          and next_attempt_at > now()
          and data ->> 'type' = 'place_arrive'
          and data ->> 'placeId' = ${transit.placeId}
          and data ->> 'userId' = ${userId}
      `)
    }

    for (const transition of transitions) {
      const verb = transition.type === "arrive" ? "arrived at" : "left"
      const worthPushing =
        batchIsLive &&
        !transited.has(transition) &&
        standingCrossings.has(transition) &&
        now.getTime() - transition.occurredAt.getTime() < ALERT_CATCH_UP_MS
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
        notify: worthPushing
          ? {
              title: transition.placeName,
              body: `${name} ${verb} ${transition.placeName}`,
              group: outingGroup(
                userId,
                name,
                `${transition.type === "arrive" ? "Arrived at" : "Left"} ${transition.placeName}`,
              ),
              // An entry waits out the time a transit would take to contradict
              // it. A leave has nothing left to be contradicted by, so it goes
              // straight out.
              notBefore:
                transition.type === "arrive"
                  ? new Date(transition.occurredAt.getTime() + TRANSIENT_VISIT_MS)
                  : undefined,
              // A held-back flush can be half an hour late, so the app needs
              // the time it happened to say "arrived at 8:31" rather than
              // implying it happened as the phone buzzed.
              data: {
                placeId: transition.placeId,
                userId,
                occurredAt: transition.occurredAt.toISOString(),
              },
            }
          : undefined,
      })
      broadcasts.push({ circleId: transition.circleId, event: dto })
    }
  })

  for (const { circleId, event } of broadcasts) {
    await broadcastEvent(circleId, event)
  }

  return transitions
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
