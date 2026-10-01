import { useState } from "react"

import { Field } from "./ui"

export function usePasswordPair() {
  const [password, setPassword] = useState("")
  const [again, setAgain] = useState("")
  return {
    password,
    again,
    setPassword,
    setAgain,
    /** Only once something is typed in the second box, so it does not scold an empty form. */
    mismatch: again.length > 0 && again !== password,
    matches: again === password,
    reset() {
      setPassword("")
      setAgain("")
    },
  }
}

type PasswordPairState = ReturnType<typeof usePasswordPair>

/** A new password and the same again, for setting your own or somebody else's. */
export function PasswordPair({ pair }: { pair: PasswordPairState }) {
  return (
    <>
      <Field label="New password" hint="At least 10 characters.">
        <input
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          value={pair.password}
          onChange={(event) => pair.setPassword(event.target.value)}
        />
      </Field>
      <Field label="The same again" hint={pair.mismatch ? "The two do not match." : undefined}>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={pair.again}
          aria-invalid={pair.mismatch || undefined}
          onChange={(event) => pair.setAgain(event.target.value)}
        />
      </Field>
    </>
  )
}
