import { load, save } from './storage'

export type Theme = 'light' | 'dark'

const KEY = 'tgv:theme'

/** Light unless the user switched to dark (the OS setting is deliberately ignored). */
export function savedTheme(): Theme {
  return load<Theme>(KEY, 'light') === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  save(KEY, theme)
}
