import type { AdminUserSummary, CurrentUser, SessionSummary } from "@hearth/shared"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"
import { flushSync } from "react-dom"

import { ApiError } from "../api"
import { client } from "../client"
import { PasswordPair, usePasswordPair } from "../components/password"
import {
  Avatar,
  Badge,
  Button,
  Confirm,
  Dialog,
  Empty,
  Field,
  Loading,
  Problem,
  useToast,
} from "../components/ui"
import { ago, date, duration, plural } from "../format"
import { useMediaQuery, useNow } from "../hooks"
import { PLATFORM_LABEL } from "../labels"
import { useAdminAction, useUserSessions, useUsers } from "../queries"
import { useCoverShell } from "../shell"

/** A phone that has sent nothing for longer than this in the last day is worth a look. */
const QUIET_SECONDS = 2 * 3600

/** Where styles.css turns the account panel into a full-window overlay. */
const OVERLAY = "(max-width: 1100px)"

export function Accounts({ me }: { me: CurrentUser }) {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  // Held here rather than found in the list, so a search that leaves the
  // account out does not close the panel somebody is working in.
  const [selected, setSelected] = useState<AdminUserSummary | null>(null)
  const now = useNow()
  const overlay = useMediaQuery(OVERLAY) && selected != null
  const rowButtons = useRef(new Map<string, HTMLButtonElement>())
  const searchBox = useRef<HTMLInputElement>(null)
  useCoverShell(overlay)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const users = useUsers(query)
  // The list only refreshes the panel when it brings a newer copy of the
  // account, so it never undoes a change the panel reported a moment ago.
  const fresh = selected ? users.data?.find((user) => user.id === selected.id) : undefined
  const [lastFresh, setLastFresh] = useState(fresh)
  if (fresh !== lastFresh) {
    setLastFresh(fresh)
    if (fresh) setSelected(fresh)
  }

  const close = () => {
    const id = selected?.id
    // The row is inert until this render lands, and inert rows take no focus.
    flushSync(() => setSelected(null))
    const row = id ? rowButtons.current.get(id) : undefined
    ;(row ?? searchBox.current)?.focus()
  }

  return (
    <div className={`split ${selected ? "split-open" : ""}`}>
      <section className="section" inert={overlay}>
        <input
          ref={searchBox}
          type="search"
          className="search"
          placeholder="Search by name or email"
          aria-label="Search accounts"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {users.error ? <Problem error={users.error} /> : null}
        {users.isPending ? <Loading /> : null}
        {users.data && users.data.length === 0 ? (
          <Empty title={query ? "No account matches that" : "No accounts yet"} />
        ) : null}
        {users.data && users.data.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Circles</th>
                  <th>Devices</th>
                  <th>Last seen</th>
                  <th>Last day</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((user) => (
                  <tr
                    key={user.id}
                    className={`clickable${user.id === selected?.id ? " selected" : ""}`}
                    onClick={() => setSelected(user)}
                  >
                    <td>
                      <button
                        ref={(button) => {
                          if (button) rowButtons.current.set(user.id, button)
                          else rowButtons.current.delete(user.id)
                        }}
                        type="button"
                        className="row-button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelected(user)
                        }}
                      >
                        <Avatar name={user.displayName} color={user.avatarColor} />
                        <span className="who">
                          <span className="who-name">
                            {user.displayName}
                            <AccountBadges user={user} me={me} />
                          </span>
                          <span className="muted small">{user.email}</span>
                        </span>
                      </button>
                    </td>
                    <td>{user.circleCount}</td>
                    <td>{user.deviceCount}</td>
                    <td>{ago(user.lastSeenAt, now)}</td>
                    <td>
                      <Silence seconds={user.longestSilenceSeconds} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {selected ? (
        <AccountPanel
          key={selected.id}
          user={selected}
          me={me}
          now={now}
          covering={overlay}
          onChanged={(patch) => setSelected((user) => (user ? { ...user, ...patch } : user))}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

function AccountBadges({ user, me }: { user: AdminUserSummary; me: CurrentUser }) {
  return (
    <>
      {user.id === me.id ? <Badge tone="accent">You</Badge> : null}
      {user.isAdmin ? <Badge>Administrator</Badge> : null}
      {!user.isActive ? <Badge tone="danger">Deactivated</Badge> : null}
    </>
  )
}

/** The longest the phone went without a fix in the last day, counting the gap still open. */
function Silence({ seconds }: { seconds: number | null }) {
  if (seconds == null) return <span className="muted">No fixes</span>
  if (seconds < QUIET_SECONDS) return <span className="muted">Reporting</span>
  return <Badge tone="warning">Quiet {duration(seconds)}</Badge>
}

type Pending = "deactivate" | "reactivate" | "promote" | "demote" | "signout-all" | null

function AccountPanel({
  user,
  me,
  now,
  covering,
  onChanged,
  onClose,
}: {
  user: AdminUserSummary
  me: CurrentUser
  now: number
  /** True while the panel covers the list, on a narrow screen. */
  covering: boolean
  /**
   * What a change did to the account. The list may not hold it to refresh
   * from, when a search has left it out.
   */
  onChanged: (patch: Partial<AdminUserSummary>) => void
  onClose: () => void
}) {
  const toast = useToast()
  const isMe = user.id === me.id
  const sessions = useUserSessions(user.id)
  const [pending, setPending] = useState<Pending>(null)
  const [endingDevice, setEndingDevice] = useState<SessionSummary | null>(null)
  const [settingPassword, setSettingPassword] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  const lastFocused = useRef<Element | null>(null)

  // On a narrow screen the panel covers the list, and a screen reader would
  // otherwise not hear that anything opened.
  useEffect(() => {
    title.current?.focus()
  }, [])

  // Narrowing the window turns the panel into an overlay and the list behind
  // it inert, which leaves nowhere for focus that was in the list.
  useEffect(() => {
    if (covering && !panel.current?.contains(document.activeElement)) title.current?.focus()
  }, [covering])

  // Signing out a device takes its button away when the list refreshes, which
  // can land after the dialog has given focus back to that button.
  useEffect(() => {
    const last = lastFocused.current
    if (last && !last.isConnected && document.activeElement === document.body) {
      title.current?.focus()
    }
  }, [sessions.data])

  const update = useAdminAction(
    (body: { isActive?: boolean; isAdmin?: boolean }) =>
      client.request(`/admin/users/${user.id}`, { method: "PATCH", body }),
    ["users", "sessions"],
  )
  const signOutAll = useAdminAction(
    () =>
      client.request<{ ok: true; revokedSessions: number }>(
        `/admin/users/${user.id}/sessions/revoke-all`,
        { method: "POST" },
      ),
    ["users", "sessions"],
  )
  const endDevice = useAdminAction(
    (sessionId: string) =>
      client.request(`/admin/users/${user.id}/sessions/${sessionId}`, { method: "DELETE" }),
    ["users", "sessions"],
  )

  const confirmations: Record<
    Exclude<Pending, null>,
    {
      title: string
      body: string
      action: string
      tone: "primary" | "danger"
      /** Resolves to what the toast says once it is done. */
      run: () => Promise<string>
    }
  > = {
    deactivate: {
      title: `Deactivate ${user.displayName}?`,
      body: "Every device is signed out and the account cannot sign in again until it is reactivated. Their circles and history stay.",
      action: "Deactivate",
      tone: "danger",
      run: async () => {
        await update.mutateAsync({ isActive: false })
        onChanged({ isActive: false })
        return `${user.displayName} is deactivated.`
      },
    },
    reactivate: {
      title: `Reactivate ${user.displayName}?`,
      body: "They can sign in again with their password.",
      action: "Reactivate",
      tone: "primary",
      run: async () => {
        await update.mutateAsync({ isActive: true })
        onChanged({ isActive: true })
        return `${user.displayName} can sign in again.`
      },
    },
    promote: {
      title: `Make ${user.displayName} an administrator?`,
      body: "They get this portal and the admin screen in the app: every account, the server's settings and its logs. They still see no one's location they have not been shared.",
      action: "Make administrator",
      tone: "primary",
      run: async () => {
        await update.mutateAsync({ isAdmin: true })
        onChanged({ isAdmin: true })
        return `${user.displayName} is an administrator.`
      },
    },
    demote: {
      title: `Remove ${user.displayName} as an administrator?`,
      body: "They are signed out everywhere, and keep their account and circles as an ordinary member.",
      action: "Remove administrator",
      tone: "danger",
      run: async () => {
        await update.mutateAsync({ isAdmin: false })
        onChanged({ isAdmin: false })
        return `${user.displayName} is no longer an administrator.`
      },
    },
    "signout-all": {
      title: `Sign ${user.displayName} out everywhere?`,
      body: isMe
        ? "Every device you are signed in on is signed out, apart from this browser."
        : "Every phone and browser they use has to sign in again. Their phone stops sharing until it does.",
      action: "Sign out everywhere",
      tone: "danger",
      run: async () => {
        const { revokedSessions } = await signOutAll.mutateAsync(undefined)
        return revokedSessions === 0
          ? `${user.displayName} was not signed in anywhere${isMe ? " else" : ""}.`
          : `${user.displayName} is signed out of ${plural(revokedSessions, "device")}.`
      },
    },
  }
  const active = pending ? confirmations[pending] : null
  const activeError = pending === "signout-all" ? signOutAll.error : update.error

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A dialog inside the panel closes itself on Escape and should not take the panel with it.
    if (event.key !== "Escape" || (event.target as Element).closest("dialog")) return
    event.preventDefault()
    onClose()
  }

  return (
    <aside
      ref={panel}
      className="panel"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onFocus={(event: FocusEvent<HTMLElement>) => {
        lastFocused.current = event.target
      }}
    >
      <div className="panel-head">
        <Avatar name={user.displayName} color={user.avatarColor} size={48} />
        <div className="who">
          <h2 className="panel-title" id={titleId} tabIndex={-1} ref={title}>
            {user.displayName}
          </h2>
          <span className="muted">{user.email}</span>
          <span className="badges">
            <AccountBadges user={user} me={me} />
          </span>
        </div>
        <Button tone="quiet" onClick={onClose}>
          Close
        </Button>
      </div>

      <dl className="facts">
        <div>
          <dt>Joined</dt>
          <dd>{date(user.createdAt)}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{ago(user.lastSeenAt, now)}</dd>
        </div>
        <div>
          <dt>Circles</dt>
          <dd>{user.circleCount}</dd>
        </div>
      </dl>

      <h3 className="panel-section">Signed-in devices</h3>
      {sessions.isPending ? <Loading /> : null}
      {sessions.error ? <Problem error={sessions.error} /> : null}
      {sessions.data && sessions.data.length === 0 ? (
        <p className="muted">Not signed in anywhere.</p>
      ) : null}
      <ul className="devices">
        {sessions.data?.map((session) => (
          <li key={session.id} className="device">
            <div>
              <p className="device-name">
                {session.deviceName ?? "Unnamed device"}
                {session.current ? <Badge tone="accent">This browser</Badge> : null}
              </p>
              <p className="muted small">
                {[
                  session.platform ? PLATFORM_LABEL[session.platform] : null,
                  session.osVersion,
                  session.appVersion && `app ${session.appVersion}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className="muted small">
                Used {ago(session.lastUsedAt ?? session.createdAt, now)}
                {session.pushEnabled ? ", gets notifications" : ""}
              </p>
            </div>
            {session.current ? null : (
              <Button tone="quiet" onClick={() => setEndingDevice(session)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {sessions.data && sessions.data.length > 1 ? (
        <Button onClick={() => setPending("signout-all")}>Sign out everywhere</Button>
      ) : null}

      <h3 className="panel-section">Access</h3>
      <div className="actions">
        {isMe ? (
          <p className="muted small">
            Change your own password under Your account. The server keeps you from removing your own
            access, so there is always somebody who can sign in here.
          </p>
        ) : (
          <>
            <Button onClick={() => setSettingPassword(true)}>Set a new password</Button>
            {user.isAdmin ? (
              <Button onClick={() => setPending("demote")}>Remove administrator</Button>
            ) : (
              <Button onClick={() => setPending("promote")}>Make administrator</Button>
            )}
            {user.isActive ? (
              <Button tone="danger" onClick={() => setPending("deactivate")}>
                Deactivate
              </Button>
            ) : (
              <Button tone="primary" onClick={() => setPending("reactivate")}>
                Reactivate
              </Button>
            )}
          </>
        )}
      </div>

      {active ? (
        <Confirm
          open
          title={active.title}
          body={<p>{active.body}</p>}
          action={active.action}
          tone={active.tone}
          busy={update.isPending || signOutAll.isPending}
          error={activeError}
          fallbackFocus={title}
          onCancel={() => {
            update.reset()
            signOutAll.reset()
            setPending(null)
          }}
          onConfirm={async () => {
            try {
              toast(await active.run())
              setPending(null)
            } catch {
              // Shown in the dialog.
            }
          }}
        />
      ) : null}

      {endingDevice ? (
        <Confirm
          open
          title={`Sign out ${endingDevice.deviceName ?? "this device"}?`}
          body={
            <p>
              For a lost or stolen phone. It stops sharing and has to sign in again with{" "}
              {user.displayName}'s password.
            </p>
          }
          action="Sign out"
          busy={endDevice.isPending}
          error={endDevice.error}
          fallbackFocus={title}
          onCancel={() => {
            endDevice.reset()
            setEndingDevice(null)
          }}
          onConfirm={async () => {
            try {
              await endDevice.mutateAsync(endingDevice.id)
              toast(`${endingDevice.deviceName ?? "The device"} is signed out.`)
              setEndingDevice(null)
            } catch {
              // Shown in the dialog.
            }
          }}
        />
      ) : null}

      <NewPassword
        user={user}
        open={settingPassword}
        fallbackFocus={title}
        onClose={() => setSettingPassword(false)}
      />
    </aside>
  )
}

function NewPassword({
  user,
  open,
  fallbackFocus,
  onClose,
}: {
  user: AdminUserSummary
  open: boolean
  fallbackFocus: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const toast = useToast()
  const pair = usePasswordPair()
  const [mine, setMine] = useState("")
  const set = useAdminAction(
    (body: { password: string; currentPassword: string }) =>
      client.request(`/admin/users/${user.id}/password`, { method: "POST", body }),
    ["users", "sessions"],
  )
  const wrongPassword = set.error instanceof ApiError && set.error.code === "wrong_password"

  const close = () => {
    pair.reset()
    setMine("")
    set.reset()
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!pair.matches) return
    try {
      await set.mutateAsync({ password: pair.password, currentPassword: mine })
      toast(`${user.displayName} is signed out everywhere, and can sign in with the new password.`)
      close()
    } catch {
      // Shown in the dialog.
    }
  }

  return (
    <Dialog
      open={open}
      title={`A new password for ${user.displayName}`}
      onClose={close}
      fallbackFocus={fallbackFocus}
    >
      <form onSubmit={submit} className="stack">
        {/* Lets a password manager file the new password under the right account. */}
        <input type="email" autoComplete="username" value={user.email} readOnly hidden />
        <p className="dialog-text">
          For somebody who forgot theirs. Hearth sends no email, so tell them the new password
          yourself. Every device they use is signed out.
        </p>
        <PasswordPair pair={pair} />
        <Field
          label="Your password"
          hint="A new password opens their account, so the server checks it is you asking."
        >
          <input
            type="password"
            autoComplete="current-password"
            required
            value={mine}
            aria-invalid={wrongPassword || undefined}
            onChange={(event) => setMine(event.target.value)}
          />
        </Field>
        {set.error ? (
          <Problem error={set.error} wording={{ wrong_password: "That is not your password." }} />
        ) : null}
        <div className="dialog-actions">
          <Button onClick={close}>Cancel</Button>
          <Button tone="primary" type="submit" busy={set.isPending} disabled={pair.mismatch}>
            Set password
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
