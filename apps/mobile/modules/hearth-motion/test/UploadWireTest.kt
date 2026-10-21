package expo.modules.hearthmotion

import org.json.JSONObject

/**
 * What the native uploader sends and how it reads the answer, and how a
 * watch it holds follows the server. Plain checks behind a main, for the
 * reasons SensorHistoryTest gives. android.jar's org.json is stubs, so a
 * real one goes first. Run from apps/mobile/modules/hearth-motion:
 *
 *   (cd ../../android && ./gradlew :hearth-motion:compileDebugKotlin)
 *   C=android/build/tmp/kotlin-classes/debug
 *   J=$(find ~/.gradle/caches -name 'json-20*.jar' | head -1)
 *   kotlinc -cp "$J:$C" -Xfriend-paths="$C" -d /tmp/hearth-motion-test test/UploadWireTest.kt
 *   kotlin -cp "$J":/tmp/hearth-motion-test:"$C" expo.modules.hearthmotion.UploadWireTestKt
 */

private const val SEEN_AT = 1_790_000_000_123L

private fun queued(accuracy: Any, speed: Any): JSONObject =
  JSONObject()
    .put("timestamp", SEEN_AT)
    .put("mocked", false)
    .put(
      "coords",
      JSONObject()
        .put("latitude", 33.6844)
        .put("longitude", 73.0479)
        .put("accuracy", accuracy)
        .put("altitude", JSONObject.NULL)
        .put("altitudeAccuracy", JSONObject.NULL)
        .put("speed", speed)
        .put("heading", JSONObject.NULL),
    )

private fun aPointIsWhatTheServerTakes() {
  val point = UploadWire.point(UploadWire.fix(queued(8.0, 3.5)), "background", "walking", 0.42, false)
  check(point.getString("recordedAt") == UploadWire.iso(SEEN_AT)) { "recordedAt: ${point.getString("recordedAt")}" }
  check(point.getDouble("lat") == 33.6844 && point.getDouble("lon") == 73.0479) { "position" }
  check(point.getDouble("accuracyMeters") == 8.0) { "accuracy" }
  check(point.getDouble("speedMps") == 3.5) { "speed" }
  check(point.isNull("altitudeMeters") && point.isNull("headingDegrees")) { "unknowns are null, not zero" }
  check(point.getString("activity") == "walking" && point.getString("source") == "background") { "labels" }
  check(point.getDouble("batteryLevel") == 0.42 && !point.getBoolean("isCharging")) { "battery" }
}

private fun aSpeedNobodyMeasuredIsNotAStop() {
  val network = UploadWire.point(UploadWire.fix(queued(65.0, 0.0)), "nudge", "still", null, null)
  check(network.isNull("speedMps")) { "a Wi-Fi fix's zero is no speed at all" }
  val gps = UploadWire.point(UploadWire.fix(queued(6.0, 0.0)), "nudge", "still", null, null)
  check(gps.getDouble("speedMps") == 0.0) { "a GPS fix's zero is a real stop" }
  val invalid = UploadWire.fix(queued(-1.0, JSONObject.NULL))
  check(invalid.accuracy == null && invalid.speed == null) { "a negative accuracy is no accuracy" }
}

private fun theAnswerIsRead() {
  val reply =
    UploadWire.reply(
      """{"accepted":3,"rejected":0,"watchedUntil":"2026-10-22T10:05:00.000Z","serverTime":"2026-10-22T10:00:00.000Z","policy":{}}""",
    )
  check(reply != null && reply.accepted == 3) { "accepted" }
  check(reply.watchedUntil!! - reply.serverTime!! == 5 * 60 * 1000L) { "five minutes left of the watch" }
  val nobody = UploadWire.reply("""{"accepted":1,"watchedUntil":null,"serverTime":"2026-10-22T10:00:00.000Z"}""")
  check(nobody != null && nobody.watchedUntil == null) { "nobody watching" }
  check(UploadWire.reply("<html>bad gateway</html>") == null) { "a page from a proxy is not an answer" }
  check(UploadWire.parseIso("2026-10-22T10:00:00Z") == UploadWire.parseIso("2026-10-22T10:00:00.000Z")) {
    "with or without milliseconds"
  }
}

private fun reply(secondsLeft: Long?): UploadWire.Reply =
  UploadWire.Reply(1, secondsLeft?.let { 1_000_000L + it * 1000 }, 1_000_000L)

private fun aWatchFollowsTheServer() {
  val window = WatchWindow()
  check(window.open(10_000, 600) == WatchWindow.Change.OPENED && window.active(10_000)) { "opened" }
  check(window.open(20_000, 60) == WatchWindow.Change.MOVED && window.until == 610_000L) {
    "a shorter ask does not cut a window short"
  }
  check(window.follow(reply(300), 30_000, 31_000) == WatchWindow.Change.MOVED && window.until == 331_000L) {
    "the server's end, from now"
  }
  check(window.follow(reply(null), 40_000, 41_000) == WatchWindow.Change.ENDED && !window.active(41_000)) {
    "nobody looking any more"
  }
}

private fun anAnswerFromBeforeTheAskSaysNothing() {
  val window = WatchWindow()
  window.open(50_000, 600)
  check(window.follow(reply(null), 49_000, 51_000) == WatchWindow.Change.NONE && window.active(51_000)) {
    "an upload sent before the ask cannot end the watch it crossed"
  }
}

private fun aWakeAnsweredDuringAWatchGoesLive() {
  val window = WatchWindow()
  check(window.follow(reply(null), 1_000, 2_000) == WatchWindow.Change.NONE && !window.active(2_000)) {
    "nobody watching, nothing to do"
  }
  check(window.follow(reply(120), 1_000, 2_000) == WatchWindow.Change.OPENED && window.until == 122_000L) {
    "somebody opened Live and the watch push never came"
  }
}

fun main() {
  aPointIsWhatTheServerTakes()
  aSpeedNobodyMeasuredIsNotAStop()
  theAnswerIsRead()
  aWatchFollowsTheServer()
  anAnswerFromBeforeTheAskSaysNothing()
  aWakeAnsweredDuringAWatchGoesLive()
  println("UploadWireTest: all passed")
}
