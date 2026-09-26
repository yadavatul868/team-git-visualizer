/** Look-back windows (the backend enforces the same set). 0 = all history, capped at the newest
 *  2,000 commits; zooming out collapses straight stretches so long histories stay readable. */
export const WINDOW_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 0, label: 'All history' },
]

export const DEFAULT_WINDOW = 30

/** A saved window that isn't offered any more (e.g. 90 days) falls back to the default. */
export function validWindow(days: unknown): number {
  return WINDOW_OPTIONS.some((option) => option.value === days) ? (days as number) : DEFAULT_WINDOW
}
