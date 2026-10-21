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
