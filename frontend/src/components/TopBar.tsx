import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'

import { relativeTime } from '../lib/format'
import type { Theme } from '../lib/theme'
import { WINDOW_OPTIONS } from '../lib/window'
import type { RepoSuggestion } from '../types'


interface TopBarProps {
  url: string
  onUrlChange: (url: string) => void
  /** Load the given URL (defaults to the one in the search box). */
  onLoad: (url?: string) => void
  suggestions: RepoSuggestion[]
  onRefresh: () => void
  canRefresh: boolean
  syncing: boolean
  fetchedAt: string | null
  days: number
  onDaysChange: (days: number) => void
  priority: string
  onPriorityChange: (priority: string) => void
  /** `owner/repo` of the loaded repository, if any. */
  repo: string | null
  onManagePeople: (() => void) | null
  theme: Theme
  onToggleTheme: () => void
}

export function TopBar(props: TopBarProps) {
  const [priorityDraft, setPriorityDraft] = useState(props.priority)
  const [, setTick] = useState(0)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const query = props.url.trim().toLowerCase()
  const exactMatch = props.suggestions.some((s) => s.url.toLowerCase() === query)
  const matches =
    !query || exactMatch
      ? props.suggestions
      : props.suggestions.filter(
          (s) => s.name.toLowerCase().includes(query) || s.url.toLowerCase().includes(query),
        )
  const showSuggestions = suggestOpen && matches.length > 0

  const choose = (suggestion: RepoSuggestion) => {
    props.onUrlChange(suggestion.url)
    setSuggestOpen(false)
    setActiveIndex(-1)
    props.onLoad(suggestion.url)
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSuggestOpen(true)
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + step + matches.length) % Math.max(1, matches.length))
    } else if (event.key === 'Enter' && showSuggestions && activeIndex >= 0) {
      event.preventDefault()
      choose(matches[activeIndex])
    } else if (event.key === 'Escape') {
      setSuggestOpen(false)
      setActiveIndex(-1)
    }
  }

  // Re-render every 30s so "fetched 2 min ago" stays current.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSuggestOpen(false)
    props.onLoad()
  }
  const applyPriority = () => {
    if (priorityDraft.trim() !== props.priority) props.onPriorityChange(priorityDraft.trim())
  }

  const status = props.syncing
    ? 'Fetching from GitHub…'
    : props.fetchedAt
      ? `Fetched ${relativeTime(props.fetchedAt)}`
      : 'Not loaded yet'

  return (
    <header className="site-header">
      {/* Utility strip */}
      <div className="utility-bar">
        <button
          type="button"
          className="theme-toggle"
          onClick={props.onToggleTheme}
          aria-label={`Switch to ${props.theme === 'light' ? 'dark' : 'light'} theme`}
        >
          <span aria-hidden>{props.theme === 'light' ? '☾' : '☀'}</span>
          {props.theme === 'light' ? 'Dark' : 'Light'}
        </button>
        <span className="fetched-at">{status}</span>
      </div>

      {/* Brand + repository search */}
      <div className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ⎇
          </span>
          Team Git Visualizer
        </div>
        <form className="repo-form" onSubmit={submit}>
          <div className="repo-combobox">
            <input
              type="url"
              className="repo-input"
              placeholder="Search your repos or paste https://github.com/owner/repo"
              value={props.url}
              onChange={(event) => {
                props.onUrlChange(event.target.value)
                setSuggestOpen(true)
                setActiveIndex(-1)
              }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setSuggestOpen(false)}
              onKeyDown={onSearchKey}
              role="combobox"
              aria-label="GitHub repository URL"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls="repo-suggestions"
              aria-activedescendant={activeIndex >= 0 ? `repo-suggestion-${activeIndex}` : undefined}
              autoComplete="off"
              required
            />
            {showSuggestions && (
              <ul id="repo-suggestions" className="repo-suggestions" role="listbox">
                {matches.map((suggestion, index) => (
                  <li
                    key={suggestion.url}
                    id={`repo-suggestion-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'is-active' : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault() // keep focus; choose before blur closes the list
                      choose(suggestion)
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span className="suggestion-name">{suggestion.name}</span>
                    <span className="suggestion-url">{suggestion.url.replace('https://', '')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" className="button primary" disabled={props.syncing}>
            Load
          </button>
          <button
            type="button"
            className="button"
            onClick={props.onRefresh}
            disabled={!props.canRefresh || props.syncing}
            title="Fetch the latest branches and commits from GitHub"
          >
            <span className={props.syncing ? 'spin' : undefined} aria-hidden>
              ↻
            </span>
            Refresh
          </button>
        </form>
      </div>

      {/* Navy navigation bar: view controls */}
      <nav className="nav-bar" aria-label="View">
        {props.repo ? (
          <a
            className="nav-title"
            href={`https://github.com/${props.repo}`}
            target="_blank"
            rel="noreferrer"
            title="Open this repository on GitHub"
          >
            {props.repo} <span aria-hidden>↗</span>
          </a>
        ) : (
          <span className="nav-title">No repository loaded</span>
        )}
        <div className="view-controls">
          <label className="field">
            <span>Window</span>
            <select value={props.days} onChange={(event) => props.onDaysChange(Number(event.target.value))}>
              {WINDOW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label
            className="field"
            title="Branches listed here come first (each followed by the branches made from it) and win shared commits, e.g. main, stage, dev"
          >
            <span>Branch priority</span>
            <input
              type="text"
              placeholder="e.g. main, stage, dev"
              value={priorityDraft}
              onChange={(event) => setPriorityDraft(event.target.value)}
              onBlur={applyPriority}
              onKeyDown={(event) => event.key === 'Enter' && applyPriority()}
            />
          </label>
          {props.onManagePeople && (
            <button
              type="button"
              className="button inverse"
              onClick={props.onManagePeople}
              title="See every identity each person committed with, and merge any the app missed"
            >
              <span aria-hidden>☺</span> People
            </button>
          )}
        </div>
      </nav>
    </header>
  )
}
