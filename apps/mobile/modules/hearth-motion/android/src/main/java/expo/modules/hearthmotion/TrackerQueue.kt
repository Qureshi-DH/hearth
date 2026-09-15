package expo.modules.hearthmotion

import android.content.Context
import android.location.Location
import android.os.Build
import java.io.File
import org.json.JSONObject

/**
 * The fixes and events the native side takes on JavaScript's behalf, and
 * the poke that tells JavaScript to come and get them. A poke goes to the
 * module when JavaScript is up and listening; otherwise the tracking
 * service, if it is running, starts the headless task, since a process
 * with a foreground service may start a service and one without may not.
 * A queue nobody can be woken for waits for the next launch, which drains
 * it first thing.
 */
internal object TrackerQueue {
  private const val DIR = "hearth-tracker"

  private fun fixes(context: Context) = LineStore(File(context.filesDir, "$DIR/fixes.jsonl"))

  private fun events(context: Context) = LineStore(File(context.filesDir, "$DIR/events.jsonl"))

  fun fix(context: Context, location: Location) {
    fixes(context).append(toJson(location).toString())
  }

  fun event(context: Context, event: JSONObject) {
    if (!event.has("at")) event.put("at", System.currentTimeMillis())
    events(context).append(event.toString())
  }

  fun drainFixes(context: Context): List<Map<String, Any?>> =
    fixes(context).drain().mapNotNull { line -> runCatching { toMap(JSONObject(line)) }.getOrNull() }

  fun drainEvents(context: Context): List<Map<String, Any?>> =
    events(context).drain().mapNotNull { line -> runCatching { toMap(JSONObject(line)) }.getOrNull() }

  /**
   * Everything not yet drained, gone. Tracking stopping means sign-out, a
   * server change or sharing off, and what the service saw on the way down
   * must not reach whichever account tracks on this phone next.
   */
  fun clear(context: Context) {
    fixes(context).clear()
    events(context).clear()
  }

  fun poke(context: Context) {
    if (HearthEvents.emit("onNativeQueue", emptyMap())) return
    if (HearthTrackingService.foreground) HearthHeadlessService.start(context, "queue")
  }

  /** The shape expo-location gives a fix, so the tracker reads both alike. */
  private fun toJson(location: Location): JSONObject {
    val coords =
      JSONObject()
        .put("latitude", location.latitude)
        .put("longitude", location.longitude)
        .put("accuracy", if (location.hasAccuracy()) location.accuracy.toDouble() else JSONObject.NULL)
        .put("altitude", if (location.hasAltitude()) location.altitude else JSONObject.NULL)
        .put(
          "altitudeAccuracy",
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
            location.verticalAccuracyMeters.toDouble()
          } else {
            JSONObject.NULL
          },
        )
        // A speed the OS did not measure is null, not zero: expo handed
        // over zero and the tracker had to guess from the accuracy.
        .put("speed", if (location.hasSpeed()) location.speed.toDouble() else JSONObject.NULL)
        .put("heading", if (location.hasBearing()) location.bearing.toDouble() else JSONObject.NULL)
    val mocked =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) location.isMock
      else @Suppress("DEPRECATION") location.isFromMockProvider
    return JSONObject().put("timestamp", location.time).put("mocked", mocked).put("coords", coords)
  }

  private fun toMap(json: JSONObject): Map<String, Any?> {
    val map = LinkedHashMap<String, Any?>()
    for (key in json.keys()) {
      map[key] =
        when (val value = json.get(key)) {
          JSONObject.NULL -> null
          is JSONObject -> toMap(value)
          else -> value
        }
    }
    return map
  }
}

/**
 * Where the module hangs its event sender while JavaScript is listening.
 * Receivers and the service emit through here; nothing listening means
 * JavaScript is down, and the queue is the way to reach it.
 */
internal object HearthEvents {
  @Volatile
  var sink: ((name: String, body: Map<String, Any?>) -> Unit)? = null

  fun emit(name: String, body: Map<String, Any?>): Boolean {
    val send = sink ?: return false
    return runCatching { send(name, body) }.isSuccess
  }
}
