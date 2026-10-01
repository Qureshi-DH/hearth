import type { RegistrationMode, ServerSettings } from "@hearth/shared"
import { useState, type FormEvent } from "react"

import { client } from "../client"
import { Button, Card, Field, Loading, Problem, useToast } from "../components/ui"
import { PUSH_PROVIDER_DETAIL, PUSH_PROVIDER_LABEL, SIGN_UP_LABEL } from "../labels"
import { useAdminAction, useServerInfo, useSettings } from "../queries"
import {
  ceilingDays,
  changesFrom,
  draftOf,
  followServer,
  type SettingsDraft,
} from "../settings-draft"

const MODES: Array<{ value: RegistrationMode; detail: string }> = [
  {
    value: "invite",
    detail: "A new account needs an invite code from a circle's admin. The usual choice.",
  },
  { value: "open", detail: "Whoever can reach this address can create an account." },
  { value: "closed", detail: "No new accounts at all. Existing ones carry on." },
]

export function Settings() {
  const settings = useSettings()
  const info = useServerInfo()
  return (
    <>
      {settings.isPending ? <Loading /> : null}
      {settings.error ? <Problem error={settings.error} /> : null}
      {settings.data ? <SettingsForm current={settings.data} /> : null}
      <section className="section">
        <h2 className="section-title">Set in the server's environment</h2>
        <p className="muted">Changing these means editing .env and restarting the server.</p>
        {info.data ? (
          <Card>
            <dl className="facts facts-wide">
              <div>
                <dt>Address</dt>
                <dd>{window.location.origin}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{info.data.version}</dd>
              </div>
              <div>
                <dt>Push notifications</dt>
                <dd>
                  {PUSH_PROVIDER_LABEL[info.data.pushProvider]}
                  <span className="fact-detail">
                    {PUSH_PROVIDER_DETAIL[info.data.pushProvider]}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Profile pictures</dt>
                <dd>{info.data.features.avatars ? "On" : "Off, no object storage is set up"}</dd>
              </div>
              <div>
                <dt>Map style</dt>
                <dd className="break">{info.data.mapStyleUrl}</dd>
              </div>
            </dl>
          </Card>
        ) : null}
      </section>
    </>
  )
}

function SettingsForm({ current }: { current: ServerSettings }) {
  const toast = useToast()
  const [draft, setDraft] = useState(() => draftOf(current))
  const [seen, setSeen] = useState(current)
  // Taken in during render rather than by remounting the form, which would
  // throw away the Save button that has focus after a save.
  if (current !== seen) {
    setSeen(current)
    setDraft(followServer(draft, seen, current))
  }
  const edit = (patch: Partial<SettingsDraft>) => setDraft((before) => ({ ...before, ...patch }))

  const save = useAdminAction(
    (body: Partial<ServerSettings>) =>
      client.request<ServerSettings>("/admin/settings", { method: "PATCH", body }),
    ["settings", "server-info"],
  )

  const days = ceilingDays(draft)
  const daysValid = days === null || (Number.isInteger(days) && days >= 1 && days <= 3650)
  const changes = changesFrom(draft, current)
  const dirty = Object.keys(changes).length > 0

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || !daysValid || draft.name.trim() === "") return
    try {
      await save.mutateAsync(changes)
      toast("Settings saved.")
    } catch {
      // Shown below the form.
    }
  }

  return (
    <form className="section stack" onSubmit={submit}>
      <Field label="Server name" hint="What the app calls this server.">
        <input
          value={draft.name}
          maxLength={80}
          required
          onChange={(event) => edit({ name: event.target.value })}
        />
      </Field>

      <fieldset className="choices">
        <legend className="field-label">Who can sign up</legend>
        {MODES.map((option) => (
          <label
            key={option.value}
            className={`choice ${draft.mode === option.value ? "chosen" : ""}`}
          >
            <input
              type="radio"
              name="registration"
              value={option.value}
              checked={draft.mode === option.value}
              onChange={() => edit({ mode: option.value })}
            />
            <span>
              <span className="choice-title">{SIGN_UP_LABEL[option.value]}</span>
              <span className="muted small">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field
        label="Longest history kept, in days"
        hint={
          daysValid
            ? "Caps what each circle may keep. Leave empty to use MAX_HISTORY_RETENTION_DAYS from the server's .env, 90 days by default."
            : "A whole number of days, from 1 to 3650."
        }
      >
        <input
          inputMode="numeric"
          value={draft.ceiling}
          aria-invalid={!daysValid || undefined}
          placeholder="From .env"
          onChange={(event) => edit({ ceiling: event.target.value.replace(/[^0-9]/g, "") })}
        />
      </Field>

      {save.error ? <Problem error={save.error} /> : null}
      <div>
        <Button
          tone="primary"
          type="submit"
          busy={save.isPending}
          aria-disabled={!dirty || !daysValid}
        >
          Save changes
        </Button>
      </div>
    </form>
  )
}
