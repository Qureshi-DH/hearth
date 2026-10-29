package expo.modules.hearthmotion

import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the native uploader sends and reads back, in the server's terms.
 * Nothing here touches Android, so it can be checked on its own
 * (test/UploadWireTest.kt).
 */
internal object UploadWire {
  /** A fix in the queue's own shape, read back. */
  data class Fix(
    val time: Long,
    val lat: Double,
    val lon: Double,
    val accuracy: Double?,
    val altitude: Double?,
    val altitudeAccuracy: Double?,
    val speed: Double?,
    val heading: Double?,
  )

  data class Reply(val accepted: Int, val watchedUntil: Long?, val serverTime: Long?)

  /** Below this a fix is GPS class, and a zero speed on it is a real stop. The tracker's own figure. */
  private const val GPS_CLASS_ACCURACY_METERS = 30.0
  /** The tracker's own figures for the labels in [activity]. */
  private const val DRIVING_SPEED_MPS = 6.0
  private const val STILL_SPEED_MPS = 0.5
  private const val STILL_SLACK_METERS = 50.0
  /** Looser than this, two fixes in the same place prove nothing about staying put. */
  private const val STILL_MAX_ACCURACY_METERS = 100.0
  private const val LABEL_MIN_GAP_MS = 60_000L
  private const val LABEL_MAX_GAP_MS = 60 * 60_000L

  fun fix(json: JSONObject): Fix {
    val coords = json.getJSONObject("coords")
    return Fix(
      time = json.getLong("timestamp"),
      lat = coords.getDouble("latitude"),
      lon = coords.getDouble("longitude"),
      accuracy = coords.number("accuracy")?.takeIf { it >= 0 },
      altitude = coords.number("altitude"),
      altitudeAccuracy = coords.number("altitudeAccuracy")?.takeIf { it >= 0 },
      speed = coords.number("speed"),
      heading = coords.number("heading")?.takeIf { it >= 0 },
    )
  }

  fun point(fix: Fix, source: String, activity: String, battery: Double?, charging: Boolean?): JSONObject =
    JSONObject()
      .put("recordedAt", iso(fix.time))
      .put("lat", fix.lat)
      .put("lon", fix.lon)
      .put("accuracyMeters", fix.accuracy.orNull())
      .put("altitudeMeters", fix.altitude.orNull())
      .put("altitudeAccuracyMeters", fix.altitudeAccuracy.orNull())
      .put("speedMps", measuredSpeed(fix.speed, fix.accuracy).orNull())
      .put("headingDegrees", fix.heading.orNull())
      .put("activity", activity)
      .put("batteryLevel", battery.orNull())
      .put("isCharging", charging ?: JSONObject.NULL)
      .put("source", source)

  fun body(points: List<JSONObject>): String = JSONObject().put("points", JSONArray(points)).toString()

  /** Null for anything that is not the server's answer to an upload. */
  fun reply(text: String): Reply? =
    try {
      val json = JSONObject(text)
      Reply(
        accepted = json.optInt("accepted", 0),
        watchedUntil = if (json.isNull("watchedUntil")) null else parseIso(json.getString("watchedUntil")),
        serverTime = if (json.isNull("serverTime")) null else parseIso(json.getString("serverTime")),
      )
    } catch (error: Exception) {
      null
    }

  /**
   * What a fix says the phone is doing: the motion sensor's word when it has
   * one, and otherwise what the fix shows. A speed
   * the GPS measured says it outright. Otherwise the fix before it does, when
   * the two are far enough apart in time to mean anything: no further apart
   * than their error circles is a phone that stayed put, and road speed
   * between them is a drive. Anything else is not known. A cell estimate a
   * kilometre wide can hide a drive inside its error circle, so "still" is
   * only said of fixes sharp enough to show it, and a drive is measured on
   * what the circles cannot explain. The same rule as pingActivity in
   * tracker.ts.
   */
  fun activity(fix: Fix, previous: Fix?, classifier: String = "unknown"): String {
    val speed = measuredSpeed(fix.speed, fix.accuracy)
    // Road speed the GPS measured is a drive, whatever the classifier said a
    // minute ago. Otherwise the motion sensor knows, where it has said.
    if (speed != null && speed >= DRIVING_SPEED_MPS) return "driving"
    if (classifier != "unknown") return classifier
    if (speed != null) {
      return when {
        speed >= DRIVING_SPEED_MPS -> "driving"
        speed < STILL_SPEED_MPS -> "still"
        else -> "unknown"
      }
    }
    if (previous == null) return "unknown"
    val gap = fix.time - previous.time
    if (gap < LABEL_MIN_GAP_MS || gap > LABEL_MAX_GAP_MS) return "unknown"
    val moved = metersBetween(previous, fix)
    val error = (fix.accuracy ?: 0.0) + (previous.accuracy ?: 0.0)
    val sharp =
      (fix.accuracy ?: Double.MAX_VALUE) <= STILL_MAX_ACCURACY_METERS &&
        (previous.accuracy ?: Double.MAX_VALUE) <= STILL_MAX_ACCURACY_METERS
    if (sharp && moved <= error + STILL_SLACK_METERS) return "still"
    return if ((moved - error) / (gap / 1000.0) >= DRIVING_SPEED_MPS) "driving" else "unknown"
  }

  /** Moving like a car: road speed measured, or well clear of the fix before at road pace. */
  fun movedLikeAVehicle(fix: Fix, previous: Fix?): Boolean {
    val speed = measuredSpeed(fix.speed, fix.accuracy)
    if (speed != null) return speed >= DRIVING_SPEED_MPS
    if (previous == null) return false
    val gap = fix.time - previous.time
    if (gap <= 0) return false
    val error = (fix.accuracy ?: 0.0) + (previous.accuracy ?: 0.0)
    return (metersBetween(previous, fix) - error) / (gap / 1000.0) >= DRIVING_SPEED_MPS
  }

  private fun metersBetween(a: Fix, b: Fix): Double {
    val earth = 6_371_000.0
    val dLat = Math.toRadians(b.lat - a.lat)
    val dLon = Math.toRadians(b.lon - a.lon)
    val h =
      Math.sin(dLat / 2).let { it * it } +
        Math.cos(Math.toRadians(a.lat)) * Math.cos(Math.toRadians(b.lat)) * Math.sin(dLon / 2).let { it * it }
    return 2 * earth * Math.asin(Math.sqrt(h))
  }

  /**
   * Android hands over 0 for a speed it never measured, and a Wi-Fi or cell
   * fix never measures one. Read as a real zero it is a car that stopped.
   */
  fun measuredSpeed(speed: Double?, accuracy: Double?): Double? {
    if (speed == null || speed < 0) return null
    if (speed == 0.0 && (accuracy == null || accuracy > GPS_CLASS_ACCURACY_METERS)) return null
    return speed
  }

  fun iso(ms: Long): String = format("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").format(ms)

  fun parseIso(value: String): Long? {
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")) {
      try {
        return format(pattern).parse(value)?.time
      } catch (error: ParseException) {
        continue
      }
    }
    return null
  }

  private fun format(pattern: String) =
    SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

  private fun JSONObject.number(key: String): Double? = if (isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }

  private fun Double?.orNull(): Any = this ?: JSONObject.NULL
}

/**
 * A Live window the native side holds, in elapsed-realtime milliseconds.
 * The server's answer to each upload names the window again, so the phone
 * follows the page being open rather than a guess made when it was asked.
 * An answer to an upload sent before the ask says nothing about this
 * window, which a slow upload crossing a new ask would otherwise end.
 */
internal class WatchWindow {
  enum class Change { NONE, OPENED, MOVED, ENDED }

  var until = 0L
    private set
  private var openedAt = 0L

  fun active(now: Long): Boolean = until > now

  fun open(now: Long, seconds: Long): Change {
    val end = now + seconds * 1000
    val opened = !active(now)
    if (opened) openedAt = now
    if (end > until) until = end
    return if (opened) Change.OPENED else Change.MOVED
  }

  fun follow(reply: UploadWire.Reply, sentAt: Long, now: Long): Change {
    val remaining =
      if (reply.watchedUntil != null && reply.serverTime != null) reply.watchedUntil - reply.serverTime else null
    if (!active(now)) {
      if (remaining == null || remaining <= 0) return Change.NONE
      openedAt = now
      until = now + remaining
      return Change.OPENED
    }
    if (sentAt < openedAt) return Change.NONE
    if (remaining == null || remaining <= 0) {
      close()
      return Change.ENDED
    }
    until = now + remaining
    return Change.MOVED
  }

  fun close() {
    until = 0L
    openedAt = 0L
  }
}
