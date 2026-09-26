import { load, save } from './storage'

/**
 * People (not git identities) get one of 8 categorical colours (--author-1 … --author-8 in index.css, the
 * validated reference palette from the dataviz guidelines). A colour follows the person, not
 * their rank: slots are handed out on first sight and remembered per repo, so switching the
 * time window never repaints anyone. Authors beyond 8 share a neutral colour; their initials
 * inside each dot still identify them.
 */
export const AUTHOR_SLOTS = 8

export type AuthorSlots = Record<string, number>

/** `personKeys` in order of activity, so the most active people claim colours first. */
export function assignAuthorSlots(repo: string, personKeys: string[]): AuthorSlots {
  const key = `tgv:person-slots:${repo.toLowerCase()}`
  const slots: AuthorSlots = { ...load<AuthorSlots>(key, {}) }
  const used = new Set(Object.values(slots))
  const current = new Set(personKeys)
  for (const person of personKeys) {
    if (person in slots) continue
    let free = Array.from({ length: AUTHOR_SLOTS }, (_, i) => i).find((slot) => !used.has(slot))
    if (free === undefined) {
      // All colours taken: reclaim one from someone not in this view (e.g. a key that changed
      // once GitHub linked their email), so current people are never left grey needlessly.
      const stale = Object.keys(slots).find((key) => !current.has(key))
      if (stale === undefined) continue
      free = slots[stale]
      delete slots[stale]
    }
    slots[person] = free
    used.add(free)
  }
  save(key, slots)
  return slots
}

export function authorColor(slots: AuthorSlots, personKey: string): string {
  const slot = slots[personKey]
  return slot === undefined ? 'var(--author-other)' : `var(--author-${slot + 1})`
}
