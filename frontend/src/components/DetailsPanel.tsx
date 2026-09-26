import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { api } from '../api'
import { authorColor, type AuthorSlots } from '../lib/colors'
import { formatDuration, formatFull, initials, relativeTime } from '../lib/format'
import type { CommitDetails, CommitRef, EdgeDetails, EdgeKind, Graph, PersonRef, Selection } from '../types'
import { FileList } from './FileList'

interface DetailsPanelProps {
  repo: string
  graph: Graph
  slots: AuthorSlots
  selection: Selection | null
  onSelectCommit: (sha: string) => void
}

type Loaded =
  | { type: 'node'; key: string; details: CommitDetails }
  | { type: 'edge'; key: string; details: EdgeDetails }

const selectionKey = (selection: Selection) =>
  selection.type === 'node' ? selection.sha : selection.id

export function DetailsPanel({ repo, graph, slots, selection, onSelectCommit }: DetailsPanelProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)

  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    const key = selectionKey(selection)
    const request =
      selection.type === 'node'
        ? api.commit(repo, selection.sha, controller.signal).then((details) =>
            setLoaded({ type: 'node', key, details }),
          )
        : api.edge(repo, selection.source, selection.target, controller.signal).then((details) =>
            setLoaded({ type: 'edge', key, details }),
          )
    request.catch((err: Error) => {
      if (err.name !== 'AbortError') setError({ key, message: err.message })
    })
    return () => controller.abort()
  }, [repo, selection])

  let body: ReactNode
  if (!selection) {
    body = (
      <div className="empty-state">
        <p>Click a commit or a connection in the graph to see its details.</p>
        <p className="muted">
          Scroll to move · pinch or ⌘ + scroll to zoom · click a branch name to jump to it
        </p>
      </div>
    )
  } else if (error?.key === selectionKey(selection)) {
    body = <p className="error-text">{error.message}</p>
  } else if (loaded?.key !== selectionKey(selection)) {
    body = <p className="muted loading">Loading…</p>
  } else if (loaded.type === 'node') {
    body = <CommitView details={loaded.details} slots={slots} onSelectCommit={onSelectCommit} />
  } else {
    const edge = graph.edges.find((candidate) => candidate.id === loaded.key)
    body = (
      <EdgeView
        details={loaded.details}
        kind={edge?.kind ?? (loaded.details.is_merge ? 'merge' : 'continue')}
        graph={graph}
        repo={repo}
        slots={slots}
        onSelectCommit={onSelectCommit}
      />
    )
  }

  return (
    <aside className="details-panel" aria-label="Details">
      {body}
    </aside>
  )
}

function CommitView({
  details,
  slots,
  onSelectCommit,
}: {
  details: CommitDetails
  slots: AuthorSlots
  onSelectCommit: (sha: string) => void
}) {
  const [subject, ...rest] = details.message.split('\n')
  const body = rest.join('\n').trim()
  const committerDiffers = details.committer_email !== details.author_email

  return (
    <div className="details">
      <div className="details-kicker">
        {details.is_merge ? 'Merge commit' : 'Commit'}
        <CopySha sha={details.sha} />
        <a href={details.url} target="_blank" rel="noreferrer" className="external-link">
          Open on GitHub ↗
        </a>
      </div>
      <h2 className="details-title">{subject}</h2>
      {body && <pre className="commit-body">{body}</pre>}

      <dl className="facts">
        <dt>Author</dt>
        <dd>
          <Person
            person={details.author}
            rawName={details.author_name}
            rawEmail={details.author_email}
            slots={slots}
          />
        </dd>
        <dt>When</dt>
        <dd>
          {formatFull(details.authored_at)}{' '}
          <span className="muted">({relativeTime(details.authored_at)})</span>
        </dd>
        {committerDiffers && (
          <>
            <dt>Committed by</dt>
            <dd>
              {details.committer_name} <span className="muted">· {formatFull(details.committed_at)}</span>
            </dd>
          </>
        )}
        {details.is_merge && details.merged_branch && (
          <>
            <dt>Merged</dt>
            <dd>
              <span className="branch-pill">{details.merged_branch}</span>
            </dd>
          </>
        )}
        {details.pr_number !== null && (
          <>
            <dt>Pull request</dt>
            <dd>
              <a href={pullUrl(details.url, details.pr_number)} target="_blank" rel="noreferrer">
                #{details.pr_number} ↗
              </a>
            </dd>
          </>
        )}
        <dt>On branches</dt>
        <dd className="pill-row">
          {details.branches.length > 0 ? (
            details.branches.map((branch) => (
              <span key={branch} className="branch-pill">
                {branch}
              </span>
            ))
          ) : (
            <span className="muted">none (only reachable through deleted branches)</span>
          )}
        </dd>
        <dt>{details.parents.length === 1 ? 'Parent' : 'Parents'}</dt>
        <dd>
          {details.parents.length === 0 ? (
            <span className="muted">none (first commit)</span>
          ) : (
            details.parents.map((parent) => (
              <CommitLink key={parent.sha} commit={parent} onSelect={onSelectCommit} />
            ))
          )}
        </dd>
      </dl>

      <h3 className="section-title">
        Files changed{details.is_merge && <span className="muted"> (vs. first parent)</span>}
      </h3>
      <FileList files={details.files} truncated={details.files_truncated} />
    </div>
  )
}

const EDGE_TITLE: Record<EdgeKind, string> = {
  continue: 'Next commit',
  'branch-off': 'Branch-off',
  merge: 'Merge',
}

function EdgeView({
  details,
  kind,
  graph,
  repo,
  slots,
  onSelectCommit,
}: {
  details: EdgeDetails
  kind: EdgeKind
  graph: Graph
  repo: string
  slots: AuthorSlots
  onSelectCommit: (sha: string) => void
}) {
  const laneName = (sha: string) => {
    const node = graph.nodes.find((candidate) => candidate.sha === sha)
    return node ? graph.lanes[node.lane]?.name : undefined
  }
  const sourceLane = laneName(details.source.sha)
  const targetLane = laneName(details.target.sha)

  let summary: ReactNode
  if (kind === 'merge') {
    summary = (
      <>
        <Branch name={details.merged_branch ?? sourceLane} /> merged into <Branch name={targetLane} />
      </>
    )
  } else if (kind === 'branch-off') {
    summary = (
      <>
        <Branch name={targetLane} /> branched off <Branch name={sourceLane} />
      </>
    )
  } else {
    summary = (
      <>
        Next commit on <Branch name={targetLane} />
      </>
    )
  }

  return (
    <div className="details">
      <div className="details-kicker">
        <span className={`edge-kind-badge kind-${kind}`}>{EDGE_TITLE[kind]}</span>
        <a href={details.url} target="_blank" rel="noreferrer" className="external-link">
          Open on GitHub ↗
        </a>
      </div>
      <h2 className="details-title">{summary}</h2>

      <div className="edge-ends">
        <EdgeEnd label="From" commit={details.source} slots={slots} onSelect={onSelectCommit} />
        <div className="edge-gap" title="Time between the two commits">
          ↓ {formatDuration(details.time_gap_seconds)} later
        </div>
        <EdgeEnd label="To" commit={details.target} slots={slots} onSelect={onSelectCommit} />
      </div>

      {details.is_merge && (
        <dl className="facts">
          <dt>Merged by</dt>
          <dd>
            {details.merged_by && (
              <Person
                person={details.merged_by}
                rawName={details.target.author_name}
                rawEmail={details.target.author_email}
                slots={slots}
              />
            )}
          </dd>
          {details.pr_number !== null && (
            <>
              <dt>Pull request</dt>
              <dd>
                <a href={`https://github.com/${repo}/pull/${details.pr_number}`} target="_blank" rel="noreferrer">
                  #{details.pr_number} ↗
                </a>
              </dd>
            </>
          )}
          <dt>Brought in</dt>
          <dd>
            {details.commits_brought_in} commit{details.commits_brought_in === 1 ? '' : 's'}
          </dd>
        </dl>
      )}

      {details.is_merge && details.brought_in.length > 0 && (
        <>
          <h3 className="section-title">Commits brought in</h3>
          <ul className="commit-list">
            {details.brought_in.map((commit) => (
              <li key={commit.sha}>
                <CommitLink commit={commit} onSelect={onSelectCommit} showAuthor slots={slots} />
              </li>
            ))}
          </ul>
          {(details.commits_brought_in ?? 0) > details.brought_in.length && (
            <p className="muted">
              …and {(details.commits_brought_in ?? 0) - details.brought_in.length} more
            </p>
          )}
        </>
      )}

      <h3 className="section-title">
        {details.is_merge ? 'Files changed by the merge' : 'Files changed'}
      </h3>
      <FileList files={details.files} truncated={details.files_truncated} />
    </div>
  )
}

function EdgeEnd({
  label,
  commit,
  slots,
  onSelect,
}: {
  label: string
  commit: CommitRef
  slots: AuthorSlots
  onSelect: (sha: string) => void
}) {
  return (
    <button type="button" className="edge-end" onClick={() => onSelect(commit.sha)}>
      <span className="edge-end-label">{label}</span>
      <AuthorDot person={commit.author} slots={slots} />
      <span className="edge-end-text">
        <span className="mono">{commit.short_sha}</span> {commit.subject}
        <span className="muted">
          {commit.author.name} · {formatFull(commit.committed_at)}
        </span>
      </span>
    </button>
  )
}

function CommitLink({
  commit,
  onSelect,
  showAuthor = false,
  slots,
}: {
  commit: CommitRef
  onSelect: (sha: string) => void
  showAuthor?: boolean
  slots?: AuthorSlots
}) {
  return (
    <button type="button" className="commit-link" onClick={() => onSelect(commit.sha)} title={commit.subject}>
      {showAuthor && slots && <AuthorDot person={commit.author} slots={slots} />}
      <span className="mono">{commit.short_sha}</span>
      <span className="commit-link-subject">{commit.subject}</span>
    </button>
  )
}

/** The resolved person, plus the raw git identity they used for this commit. */
function Person({
  person,
  rawName,
  rawEmail,
  slots,
}: {
  person: PersonRef
  rawName: string
  rawEmail: string
  slots: AuthorSlots
}) {
  return (
    <span className="person">
      <AuthorDot person={person} slots={slots} />
      <span>
        {person.name}
        {person.login && <span className="muted"> @{person.login}</span>}
      </span>
      <span className="muted identity-used" title="The git identity on this commit">
        as {rawName === person.name ? '' : `${rawName} `}&lt;{rawEmail}&gt;
      </span>
    </span>
  )
}

function AuthorDot({ person, slots }: { person: PersonRef; slots: AuthorSlots }) {
  return (
    <span className="chip-dot" style={{ '--node-color': authorColor(slots, person.key) } as CSSProperties} aria-hidden>
      {initials(person.name)}
    </span>
  )
}

function Branch({ name }: { name: string | undefined }) {
  return <span className="branch-pill">{name ?? 'unknown branch'}</span>
}

function CopySha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard
      .writeText(sha)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }
  return (
    <button type="button" className="sha-button mono" onClick={copy} title="Copy full hash">
      {copied ? 'Copied ✓' : sha.slice(0, 7)}
    </button>
  )
}

function pullUrl(commitUrl: string, pr: number): string {
  return commitUrl.replace(/\/commit\/[0-9a-f]+$/, `/pull/${pr}`)
}
