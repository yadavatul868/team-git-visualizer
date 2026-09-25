import { useEffect, useState, type FormEvent } from 'react'

import { relativeTime } from '../lib/format'

const DAY_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 0, label: 'All history' },
]

interface TopBarProps {
  url: string
  onUrlChange: (url: string) => void
  onLoad: () => void
  onRefresh: () => void
  canRefresh: boolean
  syncing: boolean
  fetchedAt: string | null
  days: number
  onDaysChange: (days: number) => void
  priority: string
  onPriorityChange: (priority: string) => void
}

export function TopBar(props: TopBarProps) {
  const [priorityDraft, setPriorityDraft] = useState(props.priority)
  const [, setTick] = useState(0)

  // Re-render every 30s so "fetched 2 min ago" stays current.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    props.onLoad()
  }
  const applyPriority = () => {
    if (priorityDraft.trim() !== props.priority) props.onPriorityChange(priorityDraft.trim())
  }

  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ⎇
        </span>
        Team Git Visualizer
      </div>

      <form className="repo-form" onSubmit={submit}>
        <input
          type="url"
          className="repo-input"
          placeholder="https://github.com/owner/repo"
          value={props.url}
          onChange={(event) => props.onUrlChange(event.target.value)}
          aria-label="GitHub repository URL"
          required
        />
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
        <span className="fetched-at">
          {props.syncing
            ? 'Fetching from GitHub…'
            : props.fetchedAt
              ? `Fetched ${relativeTime(props.fetchedAt)}`
              : ''}
        </span>
      </form>

      <div className="view-controls">
        <label className="field">
          <span>Window</span>
          <select value={props.days} onChange={(event) => props.onDaysChange(Number(event.target.value))}>
            {DAY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="field"
          title="Branches listed here get the top lanes and win shared commits, e.g. main, stage, dev"
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
      </div>
    </header>
  )
}
