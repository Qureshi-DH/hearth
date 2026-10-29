package expo.modules.hearthmotion

/**
 * What the motion sensor's word means for location, without Android. Plain
 * checks behind a main, for the reasons SensorHistoryTest gives. Run from
 * apps/mobile/modules/hearth-motion:
 *
 *   (cd ../../android && ./gradlew :hearth-motion:compileDebugKotlin)
 *   C=android/build/tmp/kotlin-classes/debug
 *   G=$(find ~/.gradle/caches -name 'play-services-location-21.3.0*.jar' | head -1)
 *   kotlinc -cp "$C:$G" -Xfriend-paths="$C" -d /tmp/hearth-motion-test test/DepartureTest.kt
 *   kotlin -cp /tmp/hearth-motion-test:"$C:$G" expo.modules.hearthmotion.DepartureTestKt
 */

private const val MINUTE = 60_000L
private const val NOW = 1_000_000_000L

private fun sharingOffStartsNothingAndStillEndsADrive() {
  check(Departure.onTransition(false, "on", true, "automotive") == Departure.Action.NONE) { "sharing off" }
  check(Departure.onTransition(true, "off", true, "automotive") == Departure.Action.NONE) { "tracker off" }
  // A drive may have outlived sharing, and only this ends it.
  check(Departure.onTransition(false, "off", false, "walking") == Departure.Action.END_DRIVE) { "on foot, off" }
}

private fun aVehicleStartsADriveOnlyForCrashDetection() {
  check(Departure.onTransition(true, "on", true, "automotive") == Departure.Action.DRIVE) { "crash alerts on" }
  check(Departure.onTransition(true, "on", false, "automotive") == Departure.Action.NONE) {
    "with crash alerts off a vehicle starts nothing"
  }
}

private fun onFootEndsTheDriveAndStillHasToHold() {
  for (activity in listOf("walking", "running", "cycling")) {
    check(Departure.onTransition(true, "on", true, activity) == Departure.Action.END_DRIVE) { activity }
  }
  check(Departure.onTransition(true, "on", true, "still") == Departure.Action.STILL_IN_DRIVE) {
    "a red light reads still too"
  }
  check(Departure.onTransition(true, "on", true, "unknown") == Departure.Action.NONE) { "unknown changes nothing" }
}

private fun aPingIsAnsweredWithoutLocationOnlyWhileStillSinceTheLastFix() {
  val fix = NOW - 10 * MINUTE
  check(Departure.stillSinceLastFix("still", fix - 5 * MINUTE, fix, NOW)) { "still before the fix and since" }
  check(!Departure.stillSinceLastFix("still", fix + MINUTE, fix, NOW)) {
    "still only after the fix: it moved on from there first"
  }
  check(!Departure.stillSinceLastFix("walking", fix - 5 * MINUTE, fix, NOW)) { "on the move" }
  check(!Departure.stillSinceLastFix("still", 0L, fix, NOW)) { "the classifier never spoke" }
  check(!Departure.stillSinceLastFix("still", fix - 5 * MINUTE, null, NOW)) { "no fix to repeat" }
  check(!Departure.stillSinceLastFix("still", NOW - 3 * 60 * MINUTE, NOW - 61 * MINUTE, NOW)) {
    "an hour on, one real fix proves it"
  }
}

private fun theServerHearsItsOwnWords() {
  check(Departure.serverActivity("automotive") == "driving")
  check(Departure.serverActivity("walking") == "walking")
  check(Departure.serverActivity("tilting") == "unknown")
}

fun main() {
  sharingOffStartsNothingAndStillEndsADrive()
  aVehicleStartsADriveOnlyForCrashDetection()
  onFootEndsTheDriveAndStillHasToHold()
  aPingIsAnsweredWithoutLocationOnlyWhileStillSinceTheLastFix()
  theServerHearsItsOwnWords()
  println("DepartureTest: all passed")
}
