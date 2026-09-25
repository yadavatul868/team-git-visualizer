import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { api } from '../api'
import { authorColor, type AuthorSlots } from '../lib/colors'
import { initials } from '../lib/format'
import type { Person } from '../types'

interface PeopleDialogProps {
  repo: string
  slots: AuthorSlots
  onClose: () => void
  /** Called after a manual merge/unmerge so the graph can reload. */
  onChanged: () => void
}

/**
 * Everyone who committed, each with every git identity (name + email) they used. Identities
 * are joined automatically (GitHub account, email, full name); this is where you check the
 * result and merge anyone the app couldn't match.
 */
export function PeopleDialog({ repo, slots, onClose, onChanged }: PeopleDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
    const controller = new AbortController()
    api
      .people(repo, controller.signal)
      .then(setPeople)
      .catch((err: Error) => err.name !== 'AbortError' && setError(err.message))
    return () => controller.abort()
  }, [repo])

  const run = async (action: () => Promise<Person[]>) => {
    setBusy(true)
    setError(null)
    try {
      setPeople(await action())
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const merge = (person: Person, targetKey: string) => {
    const target = people?.find((candidate) => candidate.key === targetKey)
    if (!target) return
    void run(() => api.linkPeople(repo, person.identities[0].email, target.identities[0].email))
  }

  return (
    <dialog ref={dialogRef} className="people-dialog" onClose={onClose} aria-labelledby="people-title">
      <header className="dialog-header">
        <h2 id="people-title">People</h2>
        <button type="button" className="banner-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <p className="muted dialog-intro">
        Each person is shown once, however many git identities they used. Identities are joined
        automatically by GitHub account, email or full name. If someone still appears twice, merge
        them here.
      </p>
      {error && <p className="error-text">{error}</p>}
      {!people ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="people-list">
          {people.map((person) => (
            <li key={person.key} className="person-row">
              <span
                className="chip-dot"
                style={{ '--node-color': authorColor(slots, person.key) } as CSSProperties}
                aria-hidden
              >
                {initials(person.name)}
              </span>
              <div className="person-main">
                <div>
                  <strong>{person.name}</strong>
                  {person.login && <span className="muted"> @{person.login}</span>}
                  <span className="muted">
                    {' '}
                    · {person.commit_count} commit{person.commit_count === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="identity-list">
                  {person.identities.map((identity) => (
                    <li key={`${identity.name}<${identity.email}>`}>
                      {identity.name} <span className="muted">&lt;{identity.email}&gt;</span>
                      <span className="muted"> · {identity.commit_count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="person-actions">
                <select
                  value=""
                  disabled={busy || people.length < 2}
                  onChange={(event) => merge(person, event.target.value)}
                  aria-label={`Merge ${person.name} into another person`}
                >
                  <option value="">Same person as…</option>
                  {people
                    .filter((other) => other.key !== person.key)
                    .map((other) => (
                      <option key={other.key} value={other.key}>
                        {other.name}
                        {other.login ? ` (@${other.login})` : ''}
                      </option>
                    ))}
                </select>
                {person.manually_linked && (
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => run(() => api.unlinkPerson(repo, person.key))}
                  >
                    Undo manual merge
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  )
}
