import { getConfig } from "./env"

export function loggerOptions() {
  const config = getConfig()
  // Tests stay quiet, but a job step throwing or an unhandled route error must
  // still surface. Silencing them lets a green run hide a broken feature.
  if (config.isTest) return { level: "error" }

  // Scrubbing belongs to every environment that serves real phones. A
  // self-hoster who starts the built server without NODE_ENV=production still
  // gets live access tokens through their logs, and those replay.
  const base = {
    level: config.LOG_LEVEL,
    // Never let credentials or tokens reach the log sink.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "body.password",
        "body.refreshToken",
        "body.token",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(request: { method: string; url: string; ip: string }) {
        return { method: request.method, url: scrubUrl(request.url), ip: request.ip }
      },
    },
  }

  if (config.isProduction) return base

  return {
    ...base,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
  }
}

/** The websocket upgrade carries the access token in the query string. Never log it. */
export function scrubUrl(url: string): string {
  return url.replace(/([?&])access_token=[^&]*/g, "$1access_token=[redacted]")
}
