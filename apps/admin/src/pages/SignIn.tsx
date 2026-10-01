import type { CurrentUser } from "@hearth/shared"
import { useState, type FormEvent } from "react"

import { ApiError, UNREACHABLE } from "../api"
import { client } from "../client"
import { Button, Field } from "../components/ui"
import { Mark } from "../components/Mark"
import { useServerInfo } from "../queries"

export function SignIn({
  onSignedIn,
  notice,
}: {
  onSignedIn: (user: CurrentUser) => void
  notice?: string
}) {
  const info = useServerInfo()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await client.signIn(email.trim(), password))
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : UNREACHABLE)
      setBusy(false)
    }
  }

  return (
    <main className="signin">
      <form className="signin-card" onSubmit={submit}>
        <Mark size={44} />
        <h1>Sign in to {info.data?.serverName ?? "Hearth"}</h1>
        <p className="muted">The admin portal, for whoever runs this server.</p>
        {notice ? <p className="note">{notice}</p> : null}
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error ? (
          <p className="problem" role="alert">
            {error}
          </p>
        ) : null}
        <Button tone="primary" type="submit" busy={busy} className="wide">
          Sign in
        </Button>
        <p className="muted small">
          Everyone else in the family uses the Hearth app. It needs this server's address:{" "}
          <strong>{window.location.origin}</strong>
        </p>
      </form>
    </main>
  )
}
