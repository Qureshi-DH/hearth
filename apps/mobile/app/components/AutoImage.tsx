import { useLayoutEffect, useState } from "react"
import { Image, ImageProps, ImageURISource, Platform, PixelRatio } from "react-native"

export interface AutoImageProps extends ImageProps {
  maxWidth?: number
  maxHeight?: number
  headers?: {
    [key: string]: string
  }
}

/**
 * Scaled dimensions for a remote image, preserving its aspect ratio.
 *
 * Not the same as `resizeMode: "contain"`. You can give just one side, and the
 * image scales to the size you ask for instead of being letterboxed inside its
 * container.
 */
export function useAutoImage(
  remoteUri: string,
  headers?: {
    [key: string]: string
  },
  dimensions?: [maxWidth?: number, maxHeight?: number],
): [width: number, height: number] {
  const [[remoteWidth, remoteHeight], setRemoteImageDimensions] = useState([0, 0])
  const remoteAspectRatio = remoteWidth / remoteHeight
  const [maxWidth, maxHeight] = dimensions ?? []

  useLayoutEffect(() => {
    if (!remoteUri) return

    if (!headers) {
      Image.getSize(remoteUri, (w, h) => setRemoteImageDimensions([w, h]))
    } else {
      Image.getSizeWithHeaders(remoteUri, headers, (w, h) => setRemoteImageDimensions([w, h]))
    }
  }, [remoteUri, headers])

  if (Number.isNaN(remoteAspectRatio)) return [0, 0]

  if (maxWidth && maxHeight) {
    const aspectRatio = Math.min(maxWidth / remoteWidth, maxHeight / remoteHeight)
    return [
      PixelRatio.roundToNearestPixel(remoteWidth * aspectRatio),
      PixelRatio.roundToNearestPixel(remoteHeight * aspectRatio),
    ]
  } else if (maxWidth) {
    return [maxWidth, PixelRatio.roundToNearestPixel(maxWidth / remoteAspectRatio)]
  } else if (maxHeight) {
    return [PixelRatio.roundToNearestPixel(maxHeight * remoteAspectRatio), maxHeight]
  } else {
    return [remoteWidth, remoteHeight]
  }
}

/** @see https://docs.infinite.red/ignite-cli/boilerplate/app/components/AutoImage/ */
export function AutoImage(props: AutoImageProps) {
  const { maxWidth, maxHeight, ...ImageProps } = props
  const source = props.source as ImageURISource
  const headers = source?.headers

  const [width, height] = useAutoImage(
    Platform.select({
      web: (source?.uri as string) ?? (source as string),
      default: source?.uri as string,
    }),
    headers,
    [maxWidth, maxHeight],
  )

  return <Image {...ImageProps} style={[{ width, height }, props.style]} />
}
