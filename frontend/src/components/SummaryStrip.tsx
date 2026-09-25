import { useState, type CSSProperties } from 'react'

import { authorColor, type AuthorSlots } from '../lib/colors'
import { initials } from '../lib/format'
import type { Graph } from '../types'

interface SummaryStripProps {
  graph: Graph
  slots: AuthorSlots
  highlightedAuthor: string | null
  onHighlightAuthor: (email: string | null) => void
}

/** Most active authors shown up front; the rest sit behind a "+N more" toggle. */
const VISIBLE_AUTHORS = 8

export function SummaryStrip({ graph, slots, highlightedAuthor, onHighlightAuthor }: SummaryStripProps) {
  const [expanded, setExpanded] = useState(false)
  const { summary } = graph
  const hidden = graph.authors.length - VISIBLE_AUTHORS
  const shown = expanded || hidden <= 0 ? graph.authors : graph.authors.slice(0, VISIBLE_AUTHORS)
  const window = graph.days ? `last ${graph.days} days` : 'all history'
  return (
    <section className="summary-strip" aria-label="Summary">
      <div className="stats">
        <Stat value={summary.commit_count} label="commits" />
        <Stat value={summary.merge_count} label="merges" />
        <Stat value={summary.branch_count} label="branches" />
        <span className="stats-window">in {window}</span>
        {graph.truncated && (
          <span className="warning-pill" title="Only the newest commits are shown">
            ⚠ Showing newest {summary.commit_count}
          </span>
        )}
      </div>
      <div
        className={`author-chips${expanded ? ' is-expanded' : ''}`}
        role="group"
        aria-label="Commits per author"
      >
        {shown.map((author) => {
          const email = author.email.toLowerCase()
          const active = highlightedAuthor === email
          return (
            <button
              key={email}
              type="button"
              className={`author-chip${active ? ' is-active' : ''}`}
              style={{ '--node-color': authorColor(slots, author.email) } as CSSProperties}
              onClick={() => onHighlightAuthor(active ? null : email)}
              title={`${author.name} <${author.email}> · click to ${active ? 'show everyone' : 'highlight their commits'}`}
              aria-pressed={active}
            >
              <span className="chip-dot" aria-hidden>
                {initials(author.name)}
              </span>
              <span className="chip-name">{author.name}</span>
              <span className="chip-count">{author.commit_count}</span>
            </button>
          )
        })}
        {hidden > 0 && (
          <button type="button" className="more-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show fewer' : `+${hidden} more`}
          </button>
        )}
      </div>
    </section>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="stat">
      <strong>{value.toLocaleString()}</strong> {label}
    </span>
  )
}
