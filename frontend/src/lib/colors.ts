import { load, save } from './storage'

/**
 * Authors get one of 8 categorical colours (--author-1 … --author-8 in index.css, the
 * validated reference palette from the dataviz guidelines). A colour follows the person, not
 * their rank: slots are handed out on first sight and remembered per repo, so switching the
 * time window never repaints anyone. Authors beyond 8 share a neutral colour; their initials
 * inside each dot still identify them.
 */
export const AUTHOR_SLOTS = 8

export type AuthorSlots = Record<string, number>

export function assignAuthorSlots(repo: string, emails: string[]): AuthorSlots {
  const key = `tgv:author-slots:${repo.toLowerCase()}`
  const slots: AuthorSlots = { ...load<AuthorSlots>(key, {}) }
  const used = new Set(Object.values(slots))
  for (const email of emails.map((e) => e.toLowerCase())) {
    if (email in slots) continue
    const free = Array.from({ length: AUTHOR_SLOTS }, (_, i) => i).find((slot) => !used.has(slot))
    if (free === undefined) continue
    slots[email] = free
    used.add(free)
  }
  save(key, slots)
  return slots
}

export function authorColor(slots: AuthorSlots, email: string): string {
  const slot = slots[email.toLowerCase()]
  return slot === undefined ? 'var(--author-other)' : `var(--author-${slot + 1})`
}

export function authorClass(slots: AuthorSlots, email: string): string {
  const slot = slots[email.toLowerCase()]
  return slot === undefined ? 'author-other' : `author-${slot + 1}`
}
