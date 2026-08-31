import { randomBytes } from "node:crypto"

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"

import { API_PREFIX } from "@hearth/shared"

import { getConfig } from "../env"

export const AVATAR_PREFIX = "avatars/"

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

let client: S3Client | null = null

/** Uploads are a capability, not a requirement. Without storage the app keeps
 * drawing initials on a colour and simply hides the button. */
export function storageEnabled(): boolean {
  const config = getConfig()
  return Boolean(config.S3_ENDPOINT && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY)
}

function getClient(): S3Client {
  if (client) return client
  const config = getConfig()
  client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? "",
    },
  })
  return client
}

let bucketReady: Promise<void> | null = null

/**
 * MinIO starts with no buckets, and making every self-hoster run a one shot mc
 * container to create one is a moving part they should not have to think about.
 */
function ensureBucket(): Promise<void> {
  if (bucketReady) return bucketReady
  const config = getConfig()
  bucketReady = (async () => {
    try {
      await getClient().send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }))
    } catch {
      try {
        await getClient().send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }))
      } catch (error) {
        // Losing the memo means the next upload tries again rather than failing
        // forever because storage happened to be slow to start.
        bucketReady = null
        throw error
      }
    }
  })()
  return bucketReady
}

/**
 * Trusting the multipart Content-Type would let anyone store whatever they
 * liked under an image name, so the bytes decide.
 */
export function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  return null
}

export function avatarKey(contentType: string): string {
  return `${AVATAR_PREFIX}${randomBytes(16).toString("hex")}.${EXTENSIONS[contentType] ?? "bin"}`
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const config = getConfig()
  await ensureBucket()
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  )
}

export interface StoredObject {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength?: number
}

export async function getObject(key: string): Promise<StoredObject | null> {
  const config = getConfig()
  try {
    const result = await getClient().send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    )
    if (!result.Body) return null
    return {
      body: result.Body as NodeJS.ReadableStream,
      contentType: result.ContentType ?? "application/octet-stream",
      contentLength: result.ContentLength,
    }
  } catch {
    return null
  }
}

export async function deleteObject(key: string): Promise<void> {
  const config = getConfig()
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }))
  } catch {
    // A missing object is the state we wanted anyway, and a storage hiccup must
    // not fail the request that replaced the avatar.
  }
}

/** Generous for a 512 pixel square. The app resizes before uploading. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/**
 * Stored as a path rather than an absolute URL so that moving the server to a
 * new hostname does not break every avatar. The app resolves it against
 * whichever server it is signed in to.
 */
export function avatarPath(key: string): string {
  return `${API_PREFIX}/media/${key}`
}

export function keyFromAvatarPath(path: string | null): string | null {
  if (!path) return null
  const prefix = `${API_PREFIX}/media/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}
