package expo.modules.hearthmotion

import android.content.Intent
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.Priority
import org.json.JSONObject

/**
 * What the tracking service asks Play Services for: the tier, in the terms
 * the JavaScript tracker hands over. The same shape expo-location built
 * from the tracker's options, so a tier reads the same on both sides.
 */
internal data class ServiceRequest(
  val priority: String,
  val intervalMs: Long,
  val distanceMeters: Float,
) {
  fun toLocationRequest(): LocationRequest =
    LocationRequest.Builder(gmsPriority, intervalMs)
      .setMinUpdateIntervalMillis(intervalMs)
      .setMaxUpdateDelayMillis(intervalMs)
      .setMinUpdateDistanceMeters(distanceMeters)
      .build()

  private val gmsPriority: Int
    get() =
      when (priority) {
        "high" -> Priority.PRIORITY_HIGH_ACCURACY
        "low" -> Priority.PRIORITY_LOW_POWER
        else -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
      }

  fun toJson(): JSONObject =
    JSONObject()
      .put("priority", priority)
      .put("intervalMs", intervalMs)
      .put("distanceMeters", distanceMeters.toDouble())

  fun putInto(intent: Intent): Intent =
    intent
      .putExtra(EXTRA_PRIORITY, priority)
      .putExtra(EXTRA_INTERVAL, intervalMs)
      .putExtra(EXTRA_DISTANCE, distanceMeters)

  companion object {
    private const val EXTRA_PRIORITY = "priority"
    private const val EXTRA_INTERVAL = "intervalMs"
    private const val EXTRA_DISTANCE = "distanceMeters"

    /** Wi-Fi grade every half minute: the walking tier before any policy has been heard. */
    val DEFAULT_MOVING = ServiceRequest("balanced", 30_000L, 0f)

    fun fromJson(json: JSONObject): ServiceRequest =
      ServiceRequest(
        json.optString("priority", "balanced"),
        json.optLong("intervalMs", DEFAULT_MOVING.intervalMs),
        json.optDouble("distanceMeters", 0.0).toFloat(),
      )

    fun fromMap(map: Map<String, Any?>): ServiceRequest =
      ServiceRequest(
        map["priority"] as? String ?: "balanced",
        (map["intervalMs"] as? Number)?.toLong() ?: DEFAULT_MOVING.intervalMs,
        (map["distanceMeters"] as? Number)?.toFloat() ?: 0f,
      )

    fun fromIntent(intent: Intent): ServiceRequest? {
      val priority = intent.getStringExtra(EXTRA_PRIORITY) ?: return null
      return ServiceRequest(
        priority,
        intent.getLongExtra(EXTRA_INTERVAL, DEFAULT_MOVING.intervalMs),
        intent.getFloatExtra(EXTRA_DISTANCE, 0f),
      )
    }
  }
}
