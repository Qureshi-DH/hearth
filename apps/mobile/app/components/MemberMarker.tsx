import { memo, useEffect } from "react"
import { Pressable, View } from "react-native"
import type { MemberPresence, PublicUser } from "@hearth/shared"
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated"

import { Avatar, type AvatarRing } from "@/components/Avatar"
import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { useAppTheme } from "@/theme/context"
import { withAlpha } from "@/utils/color"
import { FACE_BOX_PX, FACE_STRIDE_PX } from "@/utils/markerLayout"

/**
 * The name pill sits below the pointer tip, so a marker anchored by its bottom
 * edge is pushed this far up and the pill, not the pointer, lands on the
 * coordinate. Callers pass it back as the marker's pixel offset.
 */
export const MEMBER_MARKER_LABEL_HEIGHT = 24

export interface MarkerFace {
  userId: string
  user: Pick<PublicUser, "displayName" | "avatarColor" | "avatarUrl">
  label: string
  presence: MemberPresence
  ring: AvatarRing
  selected?: boolean
}

export interface MemberMarkerProps {
  /** Identifies the marker to `onMeasure`, since a group's key is its members. */
  markerKey: string
  /** Everyone stood on this spot. One face is the ordinary marker. */
  faces: MarkerFace[]
  onPress?: (userId: string) => void
  /** How wide the marker laid out, name pill included, so the map can keep neighbours clear of it. */
  onMeasure?: (key: string, width: number) => void
}

/** Two or more names in one pill, so a household reads as one place. */
export function groupLabel(labels: string[]): string {
  const [a = "", b = "", c = ""] = labels
  if (labels.length <= 1) return a
  if (labels.length === 2) return translate("map:pair", { a, b })
  if (labels.length === 3) return translate("map:trio", { a, b, c })
  return translate("map:more", { a, b, n: labels.length - 2 })
}

/**
 * Which face a touch landed on, given how far right of the marker's centre
 * it was. Android sometimes delivers a marker tap through the map's own hit
 * test rather than to the face's Pressable, and that path only knows the
 * marker and the point.
 */
export function faceAtOffset(faces: number, dx: number): number {
  const width = FACE_BOX_PX + (faces - 1) * FACE_STRIDE_PX
  const index = Math.round((dx + width / 2 - FACE_BOX_PX / 2) / FACE_STRIDE_PX)
  return Math.min(faces - 1, Math.max(0, index))
}

/**
 * Whether two sets of faces would draw the same marker. A watched phone
 * hands its marker a new presence object every second, and almost none of
 * them change the face: the map holds these views on its own surface, and
 * redrawing one for every fix is churn it does not need.
 */
export function sameFaces(a: MarkerFace[], b: MarkerFace[]): boolean {
  if (a.length !== b.length) return false
  return a.every((face, index) => {
    const other = b[index]!
    return (
      face.userId === other.userId &&
      face.label === other.label &&
      face.ring === other.ring &&
      Boolean(face.selected) === Boolean(other.selected) &&
      face.user.displayName === other.user.displayName &&
      face.user.avatarUrl === other.user.avatarUrl &&
      face.user.avatarColor === other.user.avatarColor &&
      // The only two things the face reads from a fix.
      face.presence.stale === other.presence.stale &&
      face.presence.sosAlertId === other.presence.sosAlertId
    )
  })
}

/**
 * A circle can have a dozen of these moving at once, so the only animation is
 * the SOS pulse and it runs on the UI thread. Faces that share a marker
 * overlap like a stack of photos, later ones on top and the selected one on
 * top of all, so a family at home is plainly a family at home.
 */
function MemberMarkerView({ markerKey, faces, onPress, onMeasure }: MemberMarkerProps) {
  const { theme } = useAppTheme()
  const grouped = faces.length > 1
  const anySelected = faces.some((face) => face.selected)
  // The pill answers for whoever is selected, so a second tap on it opens
  // their page as a second tap on the face would. Otherwise the first face.
  const pillFor = faces.find((face) => face.selected) ?? faces[0]
  const label = groupLabel(faces.map((face) => face.label))

  return (
    <View
      onLayout={(event) => onMeasure?.(markerKey, event.nativeEvent.layout.width)}
      style={{ alignItems: "center" }}
    >
      <View style={{ flexDirection: "row" }}>
        {faces.map((face, index) => (
          <Face
            key={face.userId}
            face={face}
            grouped={grouped}
            overlap={index > 0}
            onPress={onPress}
          />
        ))}
      </View>
      <Pressable
        onPress={pillFor ? () => onPress?.(pillFor.userId) : undefined}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ alignItems: "center" }}
      >
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: 6,
            borderRightWidth: 6,
            borderTopWidth: 8,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderTopColor: anySelected ? theme.colors.tint : theme.colors.surface,
            marginTop: -7,
          }}
        />
        <View
          style={{
            marginTop: 2,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 8,
            backgroundColor: anySelected
              ? theme.colors.tint
              : withAlpha(theme.isDark ? "#000000" : "#FFFFFF", 0.75),
          }}
        >
          <Text
            size="xxs"
            weight="semiBold"
            numberOfLines={1}
            style={{
              color: anySelected ? theme.colors.onTint : theme.colors.text,
              maxWidth: grouped ? 180 : 110,
            }}
          >
            {label}
          </Text>
        </View>
      </Pressable>
    </View>
  )
}

function Face({
  face,
  grouped,
  overlap,
  onPress,
}: {
  face: MarkerFace
  grouped: boolean
  overlap: boolean
  onPress?: (userId: string) => void
}) {
  const { theme } = useAppTheme()
  const pulse = useSharedValue(0)
  const isSos = Boolean(face.presence.sosAlertId)

  useEffect(() => {
    if (isSos) {
      pulse.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = 0
    }
  }, [isSos, pulse])

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 1.6 }],
  }))

  // A lone marker grows when picked. In a stack the faces keep their size
  // and the halo does the pointing, or the neighbours would shuffle.
  const size = face.selected && !grouped ? 56 : 46
  const faded = face.presence.stale && !isSos

  return (
    <Pressable
      onPress={() => onPress?.(face.userId)}
      hitSlop={grouped ? 0 : 8}
      testID={`member-marker-${face.userId}`}
      accessibilityRole="button"
      accessibilityLabel={face.label}
      style={{
        width: FACE_BOX_PX,
        height: FACE_BOX_PX,
        alignItems: "center",
        justifyContent: "center",
        marginLeft: overlap ? FACE_STRIDE_PX - FACE_BOX_PX : 0,
        zIndex: face.selected ? 1 : 0,
        opacity: faded ? 0.65 : 1,
      }}
    >
      {isSos ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: theme.colors.error,
            },
            pulseStyle,
          ]}
        />
      ) : null}
      <View
        style={{
          borderRadius: size / 2,
          // Stacked faces get an outline in the surface colour, so the one
          // in front cuts cleanly out of the one behind.
          borderWidth: grouped ? 2 : 0,
          borderColor: theme.colors.surface,
          shadowColor: "#000",
          shadowOpacity: 0.3,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }}
      >
        <Avatar
          user={face.user}
          size={grouped ? size - 4 : size}
          ring={face.ring === "none" ? "self" : face.ring}
        />
      </View>
      {/* The avatar's own ring is the status signal, so the selection sits
          outside it as a halo rather than taking its colour over. */}
      {face.selected ? (
        <View
          pointerEvents="none"
          testID="member-marker-halo"
          style={{
            position: "absolute",
            width: size + 10,
            height: size + 10,
            borderRadius: (size + 10) / 2,
            borderWidth: 3,
            borderColor: theme.colors.tint,
          }}
        />
      ) : null}
    </Pressable>
  )
}

export const MemberMarker = memo(MemberMarkerView, (before, after) => {
  return (
    before.markerKey === after.markerKey &&
    before.onPress === after.onPress &&
    before.onMeasure === after.onMeasure &&
    sameFaces(before.faces, after.faces)
  )
})
