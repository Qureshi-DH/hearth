package expo.modules.hearthmotion

/**
 * The pairing that makes hardware batching safe to ask for.
 *
 * Plain checks behind a main rather than a test framework, and outside the
 * android source sets: the module has no test dependencies, one pure class is a
 * thin reason to pull the JUnit toolchain into a library that would use it for
 * nothing else, and a Gradle test task that finds sources but no tests fails.
 * Run it against the compiled module, from apps/mobile/modules/hearth-motion:
 *
 *   (cd ../../android && ./gradlew :hearth-motion:compileDebugKotlin)
 *   C=android/build/tmp/kotlin-classes/debug
 *   kotlinc -cp "$C" -Xfriend-paths="$C" -d /tmp/hearth-motion-test test/SensorHistoryTest.kt
 *   kotlin -cp /tmp/hearth-motion-test:"$C" expo.modules.hearthmotion.SensorHistoryTestKt
 */

/** SensorEvent timestamps are nanoseconds, and reading a drive in them is not. */
private fun nanos(ms: Long): Long = ms * 1_000_000L

private fun unreportedSensorAnswersNothing() {
  val history = SensorHistory(4)
  check(history.at(nanos(1_000)) == null) { "a sensor that has not reported has nothing to say" }
}

private fun readsTheValueInForceAtThatInstant() {
  val history = SensorHistory(8)
  history.add(nanos(100), 1.0)
  history.add(nanos(200), 2.0)
  history.add(nanos(300), 3.0)

  check(history.at(nanos(150)) == 1.0) { "a sample between readings takes the earlier one" }
  check(history.at(nanos(200)) == 2.0) { "a sample level with a reading takes it" }
  check(history.at(nanos(250)) == 2.0) { "the newest held reading is not the newest in force" }
  check(history.at(nanos(350)) == 3.0) { "past the last reading it still stands" }
}

/**
 * The reason this class exists. Two batched sensors flush independently, so a
 * quarter second of pressure can land before the accelerometer samples it
 * overlaps. The airbag rise is read as a step above the pressure of the second
 * before the impact, so a baseline holding pressure from after it is a
 * collision the detector never sees.
 */
private fun aBurstCannotStampASampleWithItsFuture() {
  val history = SensorHistory(8)
  val impactAt = 1_200L
  history.add(nanos(900), 1013.0)
  history.add(nanos(1_100), 1013.1)
  history.add(nanos(impactAt + 100), 1013.9)
  history.add(nanos(impactAt + 300), 1014.0)

  check(history.at(nanos(1_000)) == 1013.0) { "cabin pressure a second before the impact" }
  check(history.at(nanos(1_150)) == 1013.1) { "still the baseline at the last sample before it" }
  check(history.at(nanos(1_350)) == 1013.9) { "and the rise once the airbag has fired" }
}

private fun forgottenReadingsAreNotReplacedByLaterOnes() {
  val history = SensorHistory(4)
  for (ms in longArrayOf(100, 200, 300, 400, 500)) history.add(nanos(ms), ms.toDouble())

  check(history.at(nanos(150)) == null) { "the reading in force at 150 was dropped, so nothing" }
  check(history.at(nanos(250)) == 200.0) { "what survives the wrap is still read correctly" }
  check(history.at(nanos(600)) == 500.0) { "and the newest is the newest" }
}

private fun wrappingManyTimesKeepsTheNewestWindow() {
  val history = SensorHistory(4)
  for (ms in 1L..40L) history.add(nanos(ms * 100), (ms * 100).toDouble())

  check(history.at(nanos(4_050)) == 4_000.0) { "the last reading before the sample" }
  check(history.at(nanos(3_750)) == 3_700.0) { "the oldest of the four still held" }
  check(history.at(nanos(3_650)) == null) { "everything older is gone rather than guessed at" }
}

/**
 * A history belongs to one registration, so the drive that ended cannot leave a
 * reading in the one the next drive reads from. What that costs is the first
 * few samples of a drive, which have no reading behind them yet.
 */
private fun aNewDriveStartsWithNothingBehindIt() {
  val history = SensorHistory(4)
  history.add(nanos(10_000), 1013.0)

  check(history.at(nanos(9_900)) == null) { "the drive is younger than its first reading" }
}

fun main() {
  val cases =
    listOf<Pair<String, () -> Unit>>(
      "an unreported sensor answers nothing" to ::unreportedSensorAnswersNothing,
      "a sample reads the value in force at its own instant" to ::readsTheValueInForceAtThatInstant,
      "a burst cannot stamp a sample with its future" to ::aBurstCannotStampASampleWithItsFuture,
      "forgotten readings are not replaced by later ones" to
        ::forgottenReadingsAreNotReplacedByLaterOnes,
      "wrapping many times keeps the newest window" to ::wrappingManyTimesKeepsTheNewestWindow,
      "a new drive starts with nothing behind it" to ::aNewDriveStartsWithNothingBehindIt,
    )
  for ((name, case) in cases) {
    case()
    println("ok - $name")
  }
  println("${cases.size} passed")
}
