import CoreMotion
import ExpoModulesCore

/**
 Core Motion already classifies movement for the system, so reading its answer
 costs far less than waking the GPS to infer the same thing from position.
 */
public class HearthMotionModule: Module {
  private let manager = CMMotionActivityManager()
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("HearthMotion")

    Events("onMotionChange")

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
        self.sendEvent(
          "onMotionChange",
          [
            "activity": Self.name(for: activity),
            "confidence": Self.confidence(for: activity.confidence),
          ]
        )
      }
    }

    AsyncFunction("stopUpdatesAsync") {
      guard self.running else { return }
      self.manager.stopActivityUpdates()
      self.running = false
    }

    OnDestroy {
      if self.running { self.manager.stopActivityUpdates() }
    }
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
