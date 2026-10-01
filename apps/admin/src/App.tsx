import type { CurrentUser } from "@hearth/shared"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

import { UNREACHABLE } from "./api"
import { client, SIGNED_OUT, type SignedOutEvent } from "./client"
import { Icon, type IconName } from "./components/icons"
import { Avatar, Button, Loading, useToast } from "./components/ui"
import { Mark } from "./components/Mark"
import { plural } from "./format"
import { signOutFailure } from "./messages"
import { Accounts } from "./pages/Accounts"
import { Activity } from "./pages/Activity"
import { Circles } from "./pages/Circles"
import { Notifications } from "./pages/Notifications"
import { Overview, OverviewRefresh } from "./pages/overview/Overview"
import { Settings } from "./pages/Settings"
import { SignIn } from "./pages/SignIn"
import { YourAccount } from "./pages/YourAccount"
import { useChecks, useServerInfo } from "./queries"
import { Link, PAGES, usePath, type PagePath } from "./router"
import { ShellCover } from "./shell"

/** What public/index.html calls the page, for whenever nobody is signed in. */
const SIGNED_OUT_TITLE = "Hearth admin"

type Session =
  | { status: "checking" }
  | { status: "unreachable"; retrying: boolean }
  | { status: "signed-out"; notice?: string }
  | { status: "signed-in"; user: CurrentUser }

interface NavGroup {
  label: string | null
  items: Array<{ path: PagePath; icon: IconName }>
}

const NAV: NavGroup[] = [
  { label: null, items: [{ path: "/", icon: "overview" }] },
  {
    label: "People",
    items: [
      { path: "/accounts", icon: "accounts" },
      { path: "/circles", icon: "circles" },
    ],
  },
  {
    label: "Server",
    items: [
      { path: "/settings", icon: "settings" },
      { path: "/notifications", icon: "notifications" },
      { path: "/activity", icon: "activity" },
    ],
  },
]

export function App() {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session>({ status: "checking" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    client.resume().then(
      (user) => {
        if (!cancelled) setSession(user ? { status: "signed-in", user } : { status: "signed-out" })
      },
      () => {
        if (!cancelled) setSession({ status: "unreachable", retrying: false })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    const ended = (event: Event) => {
      const reason = (event as SignedOutEvent).detail
      queryClient.clear()
      // Every call that found the session over says so, and only the first
      // one decides whether the sign-in screen explains why.
      setSession((current) =>
        current.status === "signed-out"
          ? current
          : {
              status: "signed-out",
              notice:
                reason === "expired" && current.status === "signed-in"
                  ? "You were signed out. Sign in again to carry on."
                  : undefined,
            },
      )
    }
    window.addEventListener(SIGNED_OUT, ended)
    return () => window.removeEventListener(SIGNED_OUT, ended)
  }, [queryClient])

  if (session.status === "checking") {
    return (
      <main className="signin">
        <Loading label="Opening the portal" />
      </main>
    )
  }
  if (session.status === "unreachable") {
    return (
      <main className="signin">
        <div className="signin-card">
          <Mark size={44} />
          <h1>Hearth admin</h1>
          <p className="problem" role="alert">
            {UNREACHABLE}
          </p>
          <Button
            tone="primary"
            className="wide"
            busy={session.retrying}
            onClick={() => {
              setSession({ status: "unreachable", retrying: true })
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </Button>
        </div>
      </main>
    )
  }
  if (session.status === "signed-out") {
    return (
      <SignIn
        notice={session.notice}
        onSignedIn={(user) => setSession({ status: "signed-in", user })}
      />
    )
  }
  return <Shell me={session.user} />
}

function Shell({ me }: { me: CurrentUser }) {
  const path = usePath()
  const info = useServerInfo()
  const toast = useToast()
  const [signingOut, setSigningOut] = useState(false)
  const [covered, setCovered] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const shownPath = useRef(path)
  const headingWanted = useRef(false)

  useEffect(() => {
    document.title = `${PAGES[path]} · ${info.data?.serverName ?? "Hearth"} admin`
  }, [path, info.data?.serverName])

  useEffect(
    () => () => {
      document.title = SIGNED_OUT_TITLE
    },
    [],
  )

  // Without this, focus stays on the link in the sidebar and a screen reader
  // hears nothing of the page that replaced the last one. Leaving a page
  // that covered the shell, by Back from the account panel, uncovers it a
  // render later, and an inert heading cannot take focus until then.
  useEffect(() => {
    if (shownPath.current !== path) {
      shownPath.current = path
      headingWanted.current = true
    }
    if (headingWanted.current && !covered) {
      headingWanted.current = false
      heading.current?.focus()
    }
  }, [path, covered])

  const signOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await client.signOut()
    } catch (error) {
      toast(signOutFailure(error), "danger")
      setSigningOut(false)
    }
  }

  return (
    <ShellCover.Provider value={setCovered}>
      <div className="shell">
        <a
          href="#content"
          className="skip-link visually-hidden"
          inert={covered}
          onClick={(event) => {
            event.preventDefault()
            heading.current?.focus()
          }}
        >
          Skip to content
        </a>
        <header className="sidebar" inert={covered}>
          <div className="brand">
            <Mark size={30} />
            <span className="brand-text">
              <span className="brand-name">{info.data?.serverName ?? "Hearth"}</span>
              <span className="brand-sub">Admin console</span>
            </span>
          </div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((group) => (
              <div key={group.label ?? "top"} className="nav-group">
                {group.label ? <p className="nav-heading">{group.label}</p> : null}
                {group.items.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className="nav-link"
                    aria-current={path === item.path ? "page" : undefined}
                  >
                    <Icon name={item.icon} size={17} />
                    <span>{PAGES[item.path]}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <ServerStatus />
            <div className="me-row">
              <Link
                to="/account"
                className="me-link"
                aria-current={path === "/account" ? "page" : undefined}
              >
                <Avatar name={me.displayName} color={me.avatarColor} size={30} />
                <span className="me-text">
                  <span className="me-name">{me.displayName}</span>
                  <span className="me-email">{me.email}</span>
                </span>
              </Link>
              <button
                type="button"
                className="icon-button"
                aria-label="Sign out"
                title="Sign out"
                aria-disabled={signingOut || undefined}
                onClick={signOut}
              >
                <Icon name="signOut" size={17} />
              </button>
            </div>
          </div>
        </header>
        <main className="main" id="content">
          <header className="page-head" inert={covered}>
            <h1 className="page-title" tabIndex={-1} ref={heading}>
              {PAGES[path]}
            </h1>
            {path === "/" ? <OverviewRefresh /> : null}
          </header>
          <Page path={path} me={me} />
        </main>
      </div>
    </ShellCover.Provider>
  )
}

/** One line on whether the setup needs anything, wherever the administrator is. */
function ServerStatus() {
  const checks = useChecks()
  const info = useServerInfo()
  const warnings = checks.data?.filter((check) => check.level === "warning").length ?? 0
  const unknown = !checks.data && checks.isError
  return (
    <Link to="/" className={`status ${warnings > 0 || unknown ? "status-warning" : "status-good"}`}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">
        <span className="status-title">
          {checks.data
            ? warnings > 0
              ? `${plural(warnings, "thing")} to look at`
              : "Running normally"
            : unknown
              ? "Could not check the setup"
              : "Checking the setup"}
        </span>
        {info.data ? <span className="status-sub">Hearth {info.data.version}</span> : null}
      </span>
    </Link>
  )
}

function Page({ path, me }: { path: PagePath; me: CurrentUser }) {
  switch (path) {
    case "/accounts":
      return <Accounts me={me} />
    case "/circles":
      return <Circles />
    case "/settings":
      return <Settings />
    case "/notifications":
      return <Notifications myId={me.id} />
    case "/activity":
      return <Activity />
    case "/account":
      return <YourAccount me={me} />
    default:
      return <Overview />
  }
}
