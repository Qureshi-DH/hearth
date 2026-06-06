import { useMemo, useState, type FC } from "react"
import { FlatList, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { QUICK_MESSAGES, type CircleMessage } from "@hearth/shared"
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller"

import { Avatar } from "@/components/Avatar"
import { EmptyState } from "@/components/EmptyState"
import { IconButton } from "@/components/IconButton"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { useCircle, useMembers, useMessages, useSendMessage } from "@/hooks/queries"
import { translate } from "@/i18n/translate"
import type { AppStackScreenProps } from "@/navigators/navigationTypes"
import { useAuthStore } from "@/stores/auth"
import { toast } from "@/stores/toast"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { formatClock } from "@/utils/time"
import { useHeader } from "@/utils/useHeader"

/**
 * Not a chat app. The alerts Hearth raises ("Sami was driving at 95 km/h") need
 * an obvious reply, and "please slow down" should be one tap rather than a
 * keyboard. Free text is the fallback.
 *
 * With toUserId the thread is a quiet word with one person, which is the usual
 * way in: you saw something about them and you are answering it. Without it the
 * thread is the whole family.
 */
export const MessagesScreen: FC<AppStackScreenProps<"Messages">> = ({ navigation, route }) => {
  const { circleId, toUserId } = route.params
  const { themed, theme } = useAppTheme()
  const me = useAuthStore((state) => state.user)
  const circle = useCircle(circleId)
  const { data: members } = useMembers(circleId)
  const messages = useMessages(circleId)
  const send = useSendMessage(circleId)
  const [draft, setDraft] = useState("")

  const withMember = toUserId ? members?.find((member) => member.userId === toUserId) : undefined

  useHeader(
    {
      title: withMember
        ? withMember.user.displayName
        : circle
          ? `${circle.emoji ?? ""} ${circle.name}`.trim()
          : translate("messages:title"),
      leftIcon: "back",
      onLeftPress: () => navigation.goBack(),
    },
    [circle?.name, withMember?.user.displayName, navigation],
  )

  const items = useMemo(() => {
    const all = messages.data?.pages.flatMap((page) => page.items) ?? []
    // The family thread still shows the directed ones you are party to, marked
    // with who they were for. The server already filtered out everyone else's,
    // and hiding them here would mean a message nobody ever finds.
    if (!toUserId) return all
    return all.filter(
      (message) =>
        (message.toUser?.id === toUserId && message.author.id === me?.id) ||
        (message.author.id === toUserId && message.toUser?.id === me?.id),
    )
  }, [messages.data, toUserId, me?.id])

  const submit = async (body?: string, quickKey?: string) => {
    try {
      await send.mutateAsync(quickKey ? { quickKey, toUserId } : { body, toUserId })
      setDraft("")
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} contentContainerStyle={themed($container)}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          // The API returns newest first, so inverting puts the latest at the
          // bottom where people look for it.
          inverted
          contentContainerStyle={{ padding: theme.spacing.md, gap: theme.spacing.xs }}
          onEndReached={() =>
            messages.hasNextPage && !messages.isFetchingNextPage && messages.fetchNextPage()
          }
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => (
            <Bubble message={item} mine={item.author.id === me?.id} meId={me?.id} />
          )}
          ListEmptyComponent={
            messages.isLoading ? null : (
              <EmptyState
                headingTx="messages:empty"
                contentTx="messages:emptyBody"
                style={{ paddingTop: theme.spacing.xxl }}
              />
            )
          }
        />

        <KeyboardStickyView>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              gap: 8,
              paddingHorizontal: theme.spacing.md,
              paddingBottom: 8,
            }}
          >
            {QUICK_MESSAGES.map((quick) => (
              <Pressable
                key={quick.key}
                onPress={() => submit(undefined, quick.key)}
                disabled={send.isPending}
                accessibilityRole="button"
                style={themed($chip)}
              >
                <Text size="xs" weight="medium" style={{ color: theme.colors.tint }}>
                  {quick.body}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={themed($composer)}>
            <TextField
              value={draft}
              onChangeText={setDraft}
              placeholderTx="messages:placeholder"
              multiline
              maxLength={500}
              containerStyle={{ flex: 1 }}
              inputWrapperStyle={themed($input)}
            />
            <IconButton
              icon="arrow-up"
              tone="tint"
              accessibilityLabel={translate("messages:send")}
              disabled={!draft.trim() || send.isPending}
              onPress={() => submit(draft.trim())}
            />
          </View>
        </KeyboardStickyView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Bubble({ message, mine, meId }: { message: CircleMessage; mine: boolean; meId?: string }) {
  const { theme } = useAppTheme()
  const directedAt = message.toUser
    ? message.toUser.id === meId
      ? translate("messages:toYou")
      : translate("messages:toMember", { name: message.toUser.displayName })
    : null
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 8,
        alignItems: "flex-end",
        justifyContent: mine ? "flex-end" : "flex-start",
      }}
    >
      {!mine ? <Avatar user={message.author} size={28} /> : null}
      <View
        style={{
          maxWidth: "78%",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 18,
          borderBottomLeftRadius: mine ? 18 : 4,
          borderBottomRightRadius: mine ? 4 : 18,
          backgroundColor: mine ? theme.colors.tint : theme.colors.surface,
        }}
      >
        {!mine ? (
          <Text
            size="xxs"
            weight="semiBold"
            style={{ color: theme.colors.textDim, marginBottom: 2 }}
          >
            {message.author.displayName}
          </Text>
        ) : null}
        {directedAt ? (
          <Text
            size="xxs"
            weight="medium"
            style={{
              color: mine ? theme.colors.onTint : theme.colors.tint,
              opacity: mine ? 0.85 : 1,
              marginBottom: 2,
            }}
          >
            {directedAt}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <Text
            size="sm"
            style={{ color: mine ? theme.colors.onTint : theme.colors.text, flexShrink: 1 }}
          >
            {message.body}
          </Text>
          <Text
            size="xxs"
            style={{
              color: mine ? theme.colors.onTint : theme.colors.textFaint,
              opacity: 0.7,
            }}
          >
            {formatClock(message.createdAt)}
          </Text>
        </View>
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
})
const $chip: ThemedStyle<ViewStyle> = ({ colors }) => ({
  paddingHorizontal: 14,
  paddingVertical: 9,
  borderRadius: 999,
  backgroundColor: colors.tintSoft,
})
const $composer: ThemedStyle<ViewStyle> = ({ colors, spacing }) => ({
  flexDirection: "row",
  alignItems: "flex-end",
  gap: spacing.xs,
  paddingHorizontal: spacing.md,
  paddingTop: spacing.xs,
  paddingBottom: spacing.xs,
  backgroundColor: colors.background,
})
const $input: ThemedStyle<ViewStyle> = ({ colors }) => ({
  borderRadius: 20,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  paddingVertical: 4,
})
