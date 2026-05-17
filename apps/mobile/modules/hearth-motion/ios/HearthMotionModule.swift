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
      switch CMMotionActivityManager.authorizationStatus() {
      case .authorized: return "granted"
      case .denied, .restricted: return "denied"
      default: return "undetermined"
      }
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
      ) { _, error in
        if error != nil {
          promise.resolve("denied")
        } else {
          promise.resolve("granted")
        }
      }
    }

    AsyncFunction("startUpdatesAsync") {
      guard CMMotionActivityManager.isActivityAvailable(), !self.running else { return }
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
