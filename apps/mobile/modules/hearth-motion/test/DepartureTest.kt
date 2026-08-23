package expo.modules.hearthmotion

import java.io.File

/**
 * The rules the receivers act on without JavaScript, and the store they
 * leave their evidence in. Plain checks behind a main, for the reasons
 * SensorHistoryTest gives. Run from apps/mobile/modules/hearth-motion:
 *
 *   (cd ../../android && ./gradlew :hearth-motion:compileDebugKotlin)
 *   C=android/build/tmp/kotlin-classes/debug
 *   G=$(find ~/.gradle/caches -name 'play-services-location-21.3.0*.jar' | head -1)
 *   kotlinc -cp "$C:$G" -Xfriend-paths="$C" -d /tmp/hearth-motion-test test/DepartureTest.kt
 *   kotlin -cp /tmp/hearth-motion-test:"$C:$G" expo.modules.hearthmotion.DepartureTestKt
 */

private const val NOW = 1_000_000_000L
private const val LONG_AGO = 0L

private fun sharingOffIsNeverADeparture() {
  for (activity in listOf("automotive", "walking", "still")) {
    check(Departure.onTransition(false, "stationary", false, activity, NOW, LONG_AGO) == Departure.Action.NONE) {
      "sharing off: $activity"
    }
    check(Departure.onTransition(true, "off", false, activity, NOW, LONG_AGO) == Departure.Action.NONE) {
      "tracker off: $activity"
    }
  }
  check(Departure.onFenceExit(false, "stationary", false) == Departure.Action.NONE) { "sharing off: fence" }
  check(Departure.onFenceExit(true, "off", false) == Departure.Action.NONE) { "tracker off: fence" }
}

private fun aVehicleEndsAStopOutright() {
  check(Departure.onTransition(true, "stationary", false, "automotive", NOW, NOW) == Departure.Action.TRACK) {
    "a vehicle transition starts the service, however recently a walk was checked"
  }
}

private fun onFootIsConfirmedFirstAndNotTooOften() {
  for (activity in listOf("walking", "running", "cycling")) {
    check(Departure.onTransition(true, "stationary", false, activity, NOW, LONG_AGO) == Departure.Action.BRIEF) {
      "$activity is confirmed under the brief service"
    }
    val justChecked = NOW - Departure.CONFIRM_INTERVAL_MS + 1
    check(Departure.onTransition(true, "stationary", false, activity, NOW, justChecked) == Departure.Action.NONE) {
      "$activity checked a moment ago is left alone"
    }
    val checkedLongEnoughAgo = NOW - Departure.CONFIRM_INTERVAL_MS
    check(
      Departure.onTransition(true, "stationary", false, activity, NOW, checkedLongEnoughAgo) == Departure.Action.BRIEF,
    ) {
      "$activity is checked again once the interval is up"
    }
  }
}

private fun stillAndUnknownSayNothingAboutAParkedPhone() {
  for (activity in listOf("still", "unknown")) {
    check(Departure.onTransition(true, "stationary", false, activity, NOW, LONG_AGO) == Departure.Action.NONE) {
      "$activity does not start anything"
    }
  }
}

private fun aMovingPhoneWantsItsServiceBackWhateverTheVerdict() {
  for (activity in listOf("still", "walking", "automotive", "unknown")) {
    check(Departure.onTransition(true, "moving", false, activity, NOW, LONG_AGO) == Departure.Action.TRACK) {
      "a transition brings back a service that died under a journey: $activity"
    }
    check(Departure.onTransition(true, "moving", true, activity, NOW, LONG_AGO) == Departure.Action.NONE) {
      "a running service is left alone: $activity"
    }
  }
}

private fun aFenceExitStartsTheServiceUnlessItIsUp() {
  check(Departure.onFenceExit(true, "stationary", false) == Departure.Action.TRACK) { "parked: the exit is the departure" }
  check(Departure.onFenceExit(true, "moving", false) == Departure.Action.TRACK) { "moving with no service: a re-assert" }
  check(Departure.onFenceExit(true, "moving", true) == Departure.Action.NONE) { "moving with the service up: nothing" }
  check(Departure.onFenceExit(true, "stationary", true) == Departure.Action.NONE) { "the brief service is up: nothing more" }
}

private fun theStoreHandsBackWhatWasAppendedInOrderAndOnce() {
  val file = File.createTempFile("hearth-lines", ".jsonl").apply { delete() }
  val store = LineStore(file)
  check(store.drain().isEmpty()) { "an empty store drains to nothing" }
  store.append("""{"n":1}""")
  store.append("""{"n":2}""")
  check(store.drain() == listOf("""{"n":1}""", """{"n":2}""")) { "lines come back in the order they went in" }
  check(store.drain().isEmpty()) { "a drain empties the store" }
  store.append("""{"n":3}""")
  check(store.drain() == listOf("""{"n":3}""")) { "the store takes lines again after a drain" }
}

private fun theStoreKeepsTheNewestLinesWhenNobodyDrainsIt() {
  val file = File.createTempFile("hearth-lines", ".jsonl").apply { delete() }
  val store = LineStore(file, maxBytes = 100)
  for (n in 1..40) store.append("""{"n":$n}""")
  val kept = store.drain()
  check(kept.isNotEmpty() && kept.size < 40) { "a capped store drops lines: kept ${kept.size}" }
  check(kept.last() == """{"n":40}""") { "the newest line is always kept" }
  check(kept == kept.sortedBy { it.substringAfter(":").substringBefore("}").toInt() }) { "what is kept stays in order" }
}

fun main() {
  sharingOffIsNeverADeparture()
  aVehicleEndsAStopOutright()
  onFootIsConfirmedFirstAndNotTooOften()
  stillAndUnknownSayNothingAboutAParkedPhone()
  aMovingPhoneWantsItsServiceBackWhateverTheVerdict()
  aFenceExitStartsTheServiceUnlessItIsUp()
  theStoreHandsBackWhatWasAppendedInOrderAndOnce()
  theStoreKeepsTheNewestLinesWhenNobodyDrainsIt()
  println("DepartureTest: all checks passed")
}
