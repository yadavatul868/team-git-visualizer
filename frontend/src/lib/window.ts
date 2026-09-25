/** The graph shows recent work only: at most the last 30 days (the backend enforces this too). */
export const WINDOW_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
]

export const DEFAULT_WINDOW = 30

/** A saved window from an older version (e.g. 90 days or "all") falls back to the default. */
export function validWindow(days: unknown): number {
  return WINDOW_OPTIONS.some((option) => option.value === days) ? (days as number) : DEFAULT_WINDOW
}
