import CoreMotion
import ExpoModulesCore
import UIKit

/**
 Slow enough that a drive costs a handful of bridge crossings a second rather
 than one per sample, short enough that the verdict clock on the JS side still
 starts within a couple of samples of the jolt that armed it.
 */
private let batchInterval: TimeInterval = 0.25

/// A collision is over in well under a tenth of a second, so it has to land in
/// more than one sample to be told apart from a single bad reading.
private let accelerometerInterval: TimeInterval = 0.02

/// Rotation moves on human timescales, so sampling it as hard as the
/// accelerometer would spend battery to learn nothing.
private let gyroscopeInterval: TimeInterval = 0.1

/// Core Motion reports kilopascals and the detector works in hectopascals.
private let kilopascalsToHectopascals = 10.0

/**
 Batches are drained on the main queue, and a drive lasts hours. A stall there
 has to cost the oldest samples rather than grow the buffer for ever.
 */
private let maxPendingSamples = 2_000

/**
 Core Motion reports an activity when it changes and then says nothing while
 it holds, so "still for ninety seconds" never got the second reading the JS
 side waits for. Android's classifier samples on a schedule, and this timer
 gives iOS the same shape for the one verdict that is counted: "still",
 again, at the same cadence.
 */
private let activityRepeatInterval: TimeInterval = 30

/**
 Core Motion already classifies movement for the system, so reading its answer
 costs far less than waking the GPS to infer the same thing from position.

 The module also samples the raw sensors crash detection reads. It does that
 here rather than in JS so the two platforms hand the detector the same batched
 shape, and so the accelerometer stream stops crossing the bridge one reading
 at a time.
 */
public class HearthMotionModule: Module {
  private let manager = CMMotionActivityManager()
  private var running = false
  private var lastActivity: [String: Any]?
  private var activityTimer: DispatchSourceTimer?

  private let motion = CMMotionManager()
  private let altimeter = CMAltimeter()
  /// Serial, so the readings carried onto a sample are never half written.
  private let sensorQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private let pendingLock = NSLock()
  private var pending: [[String: Any]] = []
  private var latestRotation = 0.0
  private var latestPressure: Double?
  private var bootEpoch = 0.0
  private var batchTimer: DispatchSourceTimer?

  public func definition() -> ModuleDefinition {
    Name("HearthMotion")

    Events("onMotionChange", "onSensorBatch")

    AsyncFunction("isAvailableAsync") { () -> Bool in
      CMMotionActivityManager.isActivityAvailable()
    }

    AsyncFunction("getPermissionAsync") { () -> String in
      Self.state(for: CMMotionActivityManager.authorizationStatus())
    }

    // iOS has no request call. Asking for updates is what raises the prompt,
    // so a short query both prompts and reports the answer.
    AsyncFunction("requestPermissionAsync") { (promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve("denied")
        return
      }
      let now = Date()
      self.manager.queryActivityStarting(
        from: now.addingTimeInterval(-60),
        to: now,
        to: OperationQueue.main
      ) { _, _ in
        // The error channel says whether this one query worked, not what the
        // person chose. A query can fail on a device with no recorded activity
        // while the permission is granted, and reading "denied" off that turns
        // an empty afternoon into a refusal. Ask the OS instead.
        promise.resolve(Self.state(for: CMMotionActivityManager.authorizationStatus()))
      }
    }

    AsyncFunction("startUpdatesAsync") {
      // Resolving quietly here would leave the caller holding a subscription
      // that can never fire, and believing motion tracking was running.
      guard CMMotionActivityManager.isActivityAvailable() else {
        throw Exception(
          name: "ERR_MOTION_UNAVAILABLE",
          description: "Motion activity is not available on this device"
        )
      }
      guard !self.running else { return }
      self.running = true
      self.manager.startActivityUpdates(to: OperationQueue.main) { [weak self] activity in
        guard let self, let activity else { return }
        let verdict: [String: Any] = [
          "activity": Self.name(for: activity),
          "confidence": Self.confidence(for: activity.confidence),
          "source": "sample",
        ]
        self.lastActivity = verdict
        self.sendEvent("onMotionChange", verdict)
      }
      let timer = DispatchSource.makeTimerSource(queue: .main)
      timer.schedule(deadline: .now() + activityRepeatInterval, repeating: activityRepeatInterval)
      timer.setEventHandler { [weak self] in
        // Only "still" is repeated: it is the one verdict a clock is counted
        // on, and an idling car keeps its automotive flag, which replayed
        // would un-park the car the tracker has just parked.
        guard let self, let verdict = self.lastActivity else { return }
        guard (verdict["activity"] as? String) == "still" else { return }
        self.sendEvent("onMotionChange", verdict)
      }
      timer.resume()
      self.activityTimer = timer
    }

    AsyncFunction("stopUpdatesAsync") {
      guard self.running else { return }
      self.manager.stopActivityUpdates()
      self.activityTimer?.cancel()
      self.activityTimer = nil
      self.lastActivity = nil
      self.running = false
    }

    // Background App Refresh, read from the only place that knows: nothing
    // in expo reads this switch, and the task scheduler's status merely says
    // whether the build can schedule at all.
    AsyncFunction("getBackgroundRefreshStatusAsync") { (promise: Promise) in
      DispatchQueue.main.async {
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: promise.resolve("available")
        case .denied: promise.resolve("denied")
        case .restricted: promise.resolve("restricted")
        @unknown default: promise.resolve("unknown")
        }
      }
    }

    AsyncFunction("startSensorsAsync") { () -> Bool in
      self.startSensors()
    }

    AsyncFunction("stopSensorsAsync") {
      self.stopSensors()
    }

    OnDestroy {
      if self.running { self.manager.stopActivityUpdates() }
      self.activityTimer?.cancel()
      self.activityTimer = nil
      self.stopSensors()
    }
  }

  /**
   False where the device cannot help. That is the caller's cue to fall back to
   its own sampler rather than sit waiting on a batch that never arrives.
   */
  private func startSensors() -> Bool {
    guard self.motion.isAccelerometerAvailable else { return false }
    // Starting twice would leave the first set of updates running with nothing
    // holding a reference to stop them.
    guard self.batchTimer == nil else { return true }

    // Core Motion stamps its readings against boot, so they need an offset to
    // read as a wall clock time. The two clocks are read together once here
    // rather than per batch, because re-reading them would let a clock
    // correction mid drive shuffle new samples against the ones already in the
    // detector's window.
    self.bootEpoch = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime

    // Stopping can leave a reading or two already queued, and they belong to
    // the drive that has ended rather than this one.
    self.pendingLock.lock()
    self.pending.removeAll()
    self.pendingLock.unlock()

    self.motion.accelerometerUpdateInterval = accelerometerInterval
    self.motion.startAccelerometerUpdates(to: self.sensorQueue) { [weak self] data, _ in
      guard let self, let data else { return }
      let a = data.acceleration
      self.collect(at: data.timestamp, accelG: (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot())
    }

    if self.motion.isGyroAvailable {
      self.motion.gyroUpdateInterval = gyroscopeInterval
      self.motion.startGyroUpdates(to: self.sensorQueue) { [weak self] data, _ in
        guard let self, let data else { return }
        let r = data.rotationRate
        self.latestRotation = (r.x * r.x + r.y * r.y + r.z * r.z).squareRoot()
      }
    }

    // The absence of a barometer costs one corroborating signal rather than the
    // whole feature.
    if CMAltimeter.isRelativeAltitudeAvailable() {
      self.altimeter.startRelativeAltitudeUpdates(to: self.sensorQueue) { [weak self] data, _ in
        guard let self, let data else { return }
        self.latestPressure = data.pressure.doubleValue * kilopascalsToHectopascals
      }
    }

    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + batchInterval, repeating: batchInterval)
    timer.setEventHandler { [weak self] in self?.flush() }
    timer.resume()
    self.batchTimer = timer
    return true
  }

  /// Runs on the sensor queue.
  private func collect(at uptime: TimeInterval, accelG: Double) {
    var sample: [String: Any] = [
      "t": ((self.bootEpoch + uptime) * 1000).rounded(),
      "accelG": accelG,
      "rotationRps": self.latestRotation,
    ]
    if let pressure = self.latestPressure { sample["pressure"] = pressure }
    self.pendingLock.lock()
    if self.pending.count >= maxPendingSamples { self.pending.removeFirst() }
    self.pending.append(sample)
    self.pendingLock.unlock()
  }

  private func flush() {
    self.pendingLock.lock()
    let batch = self.pending
    self.pending.removeAll(keepingCapacity: true)
    self.pendingLock.unlock()
    guard !batch.isEmpty else { return }
    self.sendEvent("onSensorBatch", ["samples": batch])
  }

  /// Safe to call when nothing is running, which is the state it wants anyway.
  private func stopSensors() {
    self.batchTimer?.cancel()
    self.batchTimer = nil
    self.motion.stopAccelerometerUpdates()
    self.motion.stopGyroUpdates()
    self.altimeter.stopRelativeAltitudeUpdates()
    self.pendingLock.lock()
    self.pending.removeAll()
    self.pendingLock.unlock()
    self.latestRotation = 0
    self.latestPressure = nil
  }

  private static func state(for status: CMAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    default: return "undetermined"
    }
  }

  /// Core Motion can report several at once, so pick the most specific.
  private static func name(for activity: CMMotionActivity) -> String {
    if activity.automotive { return "automotive" }
    if activity.cycling { return "cycling" }
    if activity.running { return "running" }
    if activity.walking { return "walking" }
    if activity.stationary { return "still" }
    return "unknown"
  }

  private static func confidence(for value: CMMotionActivityConfidence) -> Int {
    switch value {
    case .high: return 90
    case .medium: return 60
    default: return 30
    }
  }
}
