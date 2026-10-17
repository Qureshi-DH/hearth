import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startTestApp, type TestContext } from "../helpers"

/**
 * Replacing a picture deletes the old one at once, and every other phone in
 * the circle still holds the old address until its roster refreshes. A 404
 * for each of those loads is a 4xx in ordinary use, and a firewall in front
 * of a home server can answer one by locking every phone behind the address
 * out. Storage that is down is another matter. The phone keeps what it is
 * given under an address that never changes, so a blank sent then would
 * stay on screen after storage came back.
 */

let ctx: TestContext
let storage: Server

const missingKey = `avatars/${"ab".repeat(16)}.jpg`
const outageKey = `avatars/${"cd".repeat(16)}.jpg`

/** Object storage that has no such key for one address and is failing for another. */
function fakeStorage(): Server {
  return createServer((request, response) => {
    const failing = request.url?.includes(outageKey.split("/")[1]!)
    const code = failing ? "InternalError" : "NoSuchKey"
    response.writeHead(failing ? 500 : 404, { "content-type": "application/xml" })
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
        `<Message>${code}</Message><RequestId>test</RequestId></Error>`,
    )
  })
}

beforeAll(async () => {
  storage = fakeStorage()
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve))
  const { port } = storage.address() as AddressInfo
  ctx = await startTestApp({
    S3_ENDPOINT: `http://127.0.0.1:${port}`,
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
  })
})

afterAll(async () => {
  await ctx.close()
  await new Promise<void>((resolve) => storage.close(() => resolve()))
})

describe("a picture that is no longer stored", () => {
  it("answers with an empty image that is not kept, rather than a 404", async () => {
    const response = await ctx.app.inject({ method: "GET", url: `/api/v1/media/${missingKey}` })

    expect({
      status: response.statusCode,
      type: response.headers["content-type"],
      missing: response.headers["x-hearth-media"],
      cache: response.headers["cache-control"],
      isPng: response.rawPayload.subarray(1, 4).toString(),
    }).toEqual({
      status: 200,
      type: "image/png",
      missing: "missing",
      cache: "no-store",
      isPng: "PNG",
    })
  })

  it("answers storage that is failing with a 5xx, so no blank is kept in its place", async () => {
    const response = await ctx.app.inject({ method: "GET", url: `/api/v1/media/${outageKey}` })

    expect(response.statusCode).toBeGreaterThanOrEqual(500)
    expect(response.headers["x-hearth-media"]).toBeUndefined()
  }, 20_000)

  it("still refuses an address the server could never have made", async () => {
    for (const url of [
      "/api/v1/media/avatars/x.jpg",
      `/api/v1/media/other/${"ab".repeat(16)}.jpg`,
    ]) {
      const response = await ctx.app.inject({ method: "GET", url })
      expect([url, response.statusCode, response.headers["x-hearth-media"]]).toEqual([
        url,
        404,
        undefined,
      ])
    }
  })
})
