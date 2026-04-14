/** Wire up a crash reporter here. Called once from `app/app.tsx`. */
export const initCrashReporting = () => {
  // Nothing is wired up yet.
}

export enum ErrorType {
  /** Red screen in dev. The user has to sign out and restart. */
  FATAL = "Fatal",
  /** Caught by a try/catch, so the app kept running. */
  HANDLED = "Handled",
}

export const reportCrash = (error: Error, type: ErrorType = ErrorType.FATAL) => {
  if (__DEV__) {
    const message = error.message || "Unknown"
    console.error(error)
    console.log(message, type)
  } else {
    // Nothing is wired up in production yet, so these errors go nowhere.
  }
}
