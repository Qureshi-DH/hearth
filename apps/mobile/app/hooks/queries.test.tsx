import type { ReactNode } from "react"
import type { Circle } from "@hearth/shared"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react-native"

import { ApiError } from "@/services/api"
import { queryClient } from "@/services/queryClient"
import { useAuthStore } from "@/stores/auth"

import { queryKeys } from "./queryKeys"
import { useDeleteCircle, useMembers, useMyOpenSos, usePresence, useRemoveMember } from "./queries"

const mockPresence = jest.fn(async (_circleId: string) => [] as unknown[])
const mockMembers = jest.fn(async (_circleId: string) => [] as unknown[])
const mockCircles = jest.fn(async () => [] as Circle[])
const mockRemoveMember = jest.fn(async (_circleId: string, _userId: string) => ({ ok: true }))
const mockDeleteCircle = jest.fn(async (_circleId: string) => ({ ok: true }))
const mockOpenSos = jest.fn(async (_circleId: string) => [] as unknown[])

jest.mock("@/services/api", () => {
  const actual = jest.requireActual("@/services/api/client")
  return {
    ApiError: actual.ApiError,
    endpoints: {
      circles: {
        list: () => mockCircles(),
        members: (circleId: string) => mockMembers(circleId),
        removeMember: (circleId: string, userId: string) => mockRemoveMember(circleId, userId),
        remove: (circleId: string) => mockDeleteCircle(circleId),
      },
      locations: { presence: (circleId: string) => mockPresence(circleId) },
      safety: { sosHistory: (circleId: string) => mockOpenSos(circleId) },
    },
  }
})
jest.mock("@/services/location/tracker", () => ({ refreshMotionWatch: jest.fn() }))

const circle = (id: string) => ({ id, name: id, settings: {} }) as unknown as Circle

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const settle = () => act(async () => {})

beforeEach(() => {
  jest.useFakeTimers()
  queryClient.clear()
  jest.clearAllMocks()
  mockPresence.mockImplementation(async () => [])
  mockCircles.mockImplementation(async () => [])
  useAuthStore.getState().setServer("https://hearth.test", null as never)
  useAuthStore.getState().signedIn({ id: "ana" } as never)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("a circle the person is no longer in", () => {
  // Every ask for it is a 403, and a firewall in front of a home server can
  // answer those by locking every phone in the house out.
  it("stops being polled once the circles list no longer has it", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    renderHook(() => usePresence("school"), { wrapper })
    await settle()
    expect(mockPresence).toHaveBeenCalledTimes(1)

    act(() => queryClient.setQueryData(queryKeys.circles, [circle("home")]))
    // The cache tells the screen on the next tick, and the screen renders
    // before the minute is up.
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await act(async () => {
      jest.advanceTimersByTime(61_000)
    })
    expect(mockPresence).toHaveBeenCalledTimes(1)
  })

  it("is still polled while the list has it", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    renderHook(() => usePresence("school"), { wrapper })
    await settle()
    await act(async () => {
      jest.advanceTimersByTime(61_000)
    })
    expect(mockPresence).toHaveBeenCalledTimes(2)
  })

  it("has its cached answers dropped when the list loses it", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    queryClient.setQueryData(queryKeys.presence("school"), [])
    queryClient.setQueryData(queryKeys.members("school"), [])
    queryClient.setQueryData(queryKeys.presence("home"), [])

    act(() => queryClient.setQueryData(queryKeys.circles, [circle("home")]))

    expect(queryClient.getQueryData(queryKeys.presence("school"))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.members("school"))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.presence("home"))).toEqual([])
  })

  it("makes a refusal for not being a member ask for the circles once, not every time", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("school")])
    mockPresence.mockRejectedValue(new ApiError(403, "forbidden", "You are not a member."))
    mockCircles.mockResolvedValue([circle("school")])
    renderHook(() => usePresence("school"), { wrapper })
    await settle()
    expect(mockCircles).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(20_000)
      await queryClient.refetchQueries({ queryKey: queryKeys.presence("school") })
    })
    expect(mockCircles).toHaveBeenCalledTimes(1)
  })
})

describe("leaving a circle", () => {
  it("drops the circle's queries rather than asking for its members again", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    const { result } = renderHook(
      () => ({ members: useMembers("school"), remove: useRemoveMember("school") }),
      { wrapper },
    )
    await settle()
    expect(mockMembers).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.remove.mutateAsync("ana")
    })
    await settle()

    expect(mockMembers).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData<Circle[]>(queryKeys.circles)?.map((c) => c.id)).toEqual([
      "home",
    ])
  })

  it("still refreshes the members after removing somebody else", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("school")])
    const { result } = renderHook(
      () => ({ members: useMembers("school"), remove: useRemoveMember("school") }),
      { wrapper },
    )
    await settle()
    await act(async () => {
      await result.current.remove.mutateAsync("omar")
    })
    await settle()
    expect(mockMembers).toHaveBeenCalledTimes(2)
  })

  it("drops a deleted circle's queries the same way", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    queryClient.setQueryData(queryKeys.presence("school"), [])
    const { result } = renderHook(
      () => ({ members: useMembers("school"), remove: useDeleteCircle() }),
      { wrapper },
    )
    await settle()
    await act(async () => {
      await result.current.remove.mutateAsync("school")
    })
    await settle()
    expect(mockMembers).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(queryKeys.presence("school"))).toBeUndefined()
  })
})

describe("your own open alert", () => {
  // The cache tells the hook on the next tick.
  const answered = async () => {
    await settle()
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
  }

  const alert = (id: string, circleId: string, userId: string) => ({
    id,
    circleId,
    user: { id: userId },
    startedAt: "2026-10-17T10:00:00.000Z",
    note: null,
  })

  // An admin can close one circle's copy and leave the rest open, and the
  // screen may be opened on that circle.
  it("is found in another circle when the one on screen has none", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    mockOpenSos.mockImplementation(async (circleId: string) =>
      circleId === "school" ? [alert("school-alert", "school", "ana")] : [],
    )

    const { result } = renderHook(() => useMyOpenSos("home"), { wrapper })
    await answered()

    expect(result.current?.id).toBe("school-alert")
  })

  it("prefers the circle on screen, and ignores somebody else's", async () => {
    queryClient.setQueryData(queryKeys.circles, [circle("home"), circle("school")])
    mockOpenSos.mockImplementation(async (circleId: string) =>
      circleId === "home"
        ? [alert("theirs", "home", "bo"), alert("home-alert", "home", "ana")]
        : [alert("school-alert", "school", "ana")],
    )

    const { result } = renderHook(() => useMyOpenSos("home"), { wrapper })
    await answered()

    expect(result.current?.id).toBe("home-alert")
  })
})
