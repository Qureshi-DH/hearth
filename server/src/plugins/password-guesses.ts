import type { FastifyInstance, FastifyRequest } from "fastify"

import { AppError, tooManyRequests } from "../lib/errors"

/**
 * A budget of wrong guesses at the signed-in person's own password, asked for
 * before a change that matters. Somebody who finds a session open could
 * otherwise guess for as long as it lasts. Right answers cost nothing.
 */
const WRONG_GUESSES = 10

export function passwordGuesses(app: FastifyInstance) {
  const budget = app.createRateLimit({
    // A count read without adding to it is over only once it passes the
    // maximum, so the last guess allowed is one past it.
    max: WRONG_GUESSES - 1,
    timeWindow: "15 minutes",
    keyGenerator: (request) => `password-guess:${request.auth?.userId ?? request.ip}`,
  })

  return async function guarded(request: FastifyRequest, confirm: () => Promise<void>) {
    const left = await budget(request, { increment: false })
    if (!left.isAllowed && left.isExceeded) {
      throw tooManyRequests("Too many wrong passwords. Try again in a quarter of an hour.")
    }
    try {
      await confirm()
    } catch (error) {
      if (error instanceof AppError && error.code === "wrong_password") await budget(request)
      throw error
    }
  }
}
