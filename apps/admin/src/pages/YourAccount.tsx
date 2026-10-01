import type { CurrentUser } from "@hearth/shared"
import { useState, type FormEvent } from "react"

import { ApiError } from "../api"
import { client } from "../client"
import { PasswordPair, usePasswordPair } from "../components/password"
import { Avatar, Button, Card, Field, Problem, useToast } from "../components/ui"

export function YourAccount({ me }: { me: CurrentUser }) {
  const toast = useToast()
  const [current, setCurrent] = useState("")
  const pair = usePasswordPair()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const wrongPassword = error instanceof ApiError && error.code === "wrong_password"

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!pair.matches) return
    setBusy(true)
    setError(null)
    try {
      await client.request("/auth/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: pair.password },
      })
      setCurrent("")
      pair.reset()
      toast("Your password is changed.")
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="section">
        <Card className="account-card">
          <Avatar name={me.displayName} color={me.avatarColor} size={48} />
          <div>
            <p className="account-name">{me.displayName}</p>
            <p className="muted">{me.email}</p>
          </div>
        </Card>
      </section>
      <form className="section stack narrow" onSubmit={submit}>
        <h2 className="section-title">Change your password</h2>
        <input type="email" autoComplete="username" value={me.email} readOnly hidden />
        <Field label="Current password">
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            aria-invalid={wrongPassword || undefined}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <PasswordPair pair={pair} />
        {error ? (
          <Problem
            error={error}
            wording={{ wrong_password: "That is not your current password." }}
          />
        ) : null}
        <div>
          <Button tone="primary" type="submit" busy={busy} disabled={pair.mismatch}>
            Change password
          </Button>
        </div>
      </form>
    </>
  )
}
