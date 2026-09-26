import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from './api'
import { DetailsPanel } from './components/DetailsPanel'
import { GraphPanel } from './components/GraphPanel'
import { PeopleDialog } from './components/PeopleDialog'
import { SummaryStrip } from './components/SummaryStrip'
import { TopBar } from './components/TopBar'
import { assignAuthorSlots } from './lib/colors'
import {
  arrangeRows,
  savedLayout,
  savedShowFinished,
  saveLayout,
  saveShowFinished,
  type LaneLayout,
} from './lib/rows'
import { load, save } from './lib/storage'
import { applyTheme, savedTheme, type Theme } from './lib/theme'
import { DEFAULT_WINDOW, validWindow } from './lib/window'
import type { Graph, RepoSuggestion, Selection } from './types'

const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

function repoKeyFromUrl(url: string): string | null {
  const match = GITHUB_URL_RE.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

const priorityKey = (repo: string) => `tgv:priority:${repo.toLowerCase()}`
const parsePriority = (value: string) =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

export default function App() {
  const [url, setUrl] = useState(() => load('tgv:url', ''))
  const [repo, setRepo] = useState<string | null>(() => repoKeyFromUrl(load('tgv:url', '')))
  const [days, setDays] = useState(() => validWindow(load<unknown>('tgv:days', DEFAULT_WINDOW)))
  const [priority, setPriority] = useState(() => {
    const saved = repoKeyFromUrl(load('tgv:url', ''))
    return saved ? load(priorityKey(saved), '') : ''
  })
  const [result, setResult] = useState<{ key: string; graph: Graph | null } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenMissing, setTokenMissing] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [focusSha, setFocusSha] = useState<string | null>(null)
  const [highlightedAuthor, setHighlightedAuthor] = useState<string | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [suggestions, setSuggestions] = useState<RepoSuggestion[]>([])
  const [layout, setLayout] = useState<LaneLayout>(savedLayout)
  const [showFinished, setShowFinished] = useState(savedShowFinished)
  const changeShowFinished = (show: boolean) => {
    setShowFinished(show)
    saveShowFinished(show)
  }

  useEffect(() => {
    api
      .repoSuggestions()
      .then(setSuggestions)
      .catch((err: Error) => setError(`Repo suggestions: ${err.message}`))
  }, [])

  useEffect(() => {
    api
      .health()
      .then((health) => setTokenMissing(!health.token_configured))
      .catch(() => setError('Can’t reach the backend. Is it running? Start everything with ./dev.sh'))
  }, [])

  // (Re)load the graph from the backend's local copy whenever the repo, window or priority changes.
  const requestKey = repo ? `${repo}|${days}|${priority}|${graphVersion}` : null
  useEffect(() => {
    if (!repo || !requestKey) return
    const controller = new AbortController()
    api
      .graph(repo, days, parsePriority(priority), controller.signal)
      .then((next) => {
        setResult({ key: requestKey, graph: next })
        setError(null)
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        setResult({ key: requestKey, graph: null })
        // A repo that was never synced on this machine just needs a Load; not an error worth shouting.
        if (!err.message.includes("hasn't been loaded")) setError(err.message)
      })
    return () => controller.abort()
  }, [repo, days, priority, requestKey])

  const loadingGraph = requestKey !== null && result?.key !== requestKey
  // Keep showing the current graph while a new window/priority loads, but never another repo's.
  const graph = result?.graph && result.graph.repo.toLowerCase() === repo?.toLowerCase() ? result.graph : null

  /** Fetch the latest snapshot from GitHub (clones on first use), then reload the graph. */
  const sync = async (targetUrl: string) => {
    setSyncing(true)
    setError(null)
    try {
      const snapshot = await api.sync(targetUrl)
      save('tgv:url', targetUrl.trim())
      if (repo?.toLowerCase() !== snapshot.repo.toLowerCase()) {
        setRepo(snapshot.repo)
        setPriority(load(priorityKey(snapshot.repo), ''))
        setSelection(null)
        setHighlightedAuthor(null)
      }
      setGraphVersion((version) => version + 1)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const slots = useMemo(
    () => (graph ? assignAuthorSlots(graph.repo, graph.authors.map((author) => author.key)) : {}),
    [graph],
  )

  const arrangement = useMemo(
    () => (graph ? arrangeRows(graph, layout, showFinished) : null),
    [graph, layout, showFinished],
  )
  const finishedCount = graph ? graph.lanes.filter((lane) => lane.finished).length : 0

  const selectCommit = useCallback((sha: string) => {
    setSelection({ type: 'node', sha })
    setFocusSha(sha)
  }, [])

  return (
    <div className="app">
      <TopBar
        key={repo ?? ''}
        url={url}
        onUrlChange={setUrl}
        onLoad={(target) => sync(target ?? url)}
        suggestions={suggestions}
        onRefresh={() => sync(url)}
        canRefresh={repo !== null && repoKeyFromUrl(url)?.toLowerCase() === repo.toLowerCase()}
        syncing={syncing}
        fetchedAt={graph?.fetched_at ?? null}
        days={days}
        onDaysChange={(value) => {
          setDays(value)
          save('tgv:days', value)
        }}
        priority={priority}
        onPriorityChange={(value) => {
          setPriority(value)
          if (repo) save(priorityKey(repo), value)
        }}
        repo={graph?.repo ?? repo}
        onManagePeople={graph ? () => setPeopleOpen(true) : null}
        layout={layout}
        onLayoutChange={(value) => {
          setLayout(value)
          saveLayout(value)
        }}
        finishedCount={finishedCount}
        showFinished={showFinished}
        onShowFinishedChange={changeShowFinished}
        theme={theme}
        onToggleTheme={() => {
          const next = theme === 'light' ? 'dark' : 'light'
          applyTheme(next)
          setTheme(next)
        }}
      />

      {tokenMissing && (
        <div className="banner warning">
          No <code>GITHUB_PAT</code> in <code>.env</code>. Only public repos can be loaded.
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button type="button" className="banner-close" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {graph ? (
        <SummaryStrip
          graph={graph}
          slots={slots}
          highlightedAuthor={highlightedAuthor}
          onHighlightAuthor={setHighlightedAuthor}
        />
      ) : null}
      {peopleOpen && graph && (
        <PeopleDialog
          repo={graph.repo}
          slots={slots}
          onClose={() => setPeopleOpen(false)}
          onChanged={() => {
            setHighlightedAuthor(null)
            setGraphVersion((version) => version + 1)
          }}
        />
      )}

      <main className={`workspace${loadingGraph ? ' is-loading' : ''}`}>
        {graph && arrangement && graph.nodes.length > 0 ? (
          <>
            <GraphPanel
              graph={graph}
              slots={slots}
              selection={selection}
              highlightedAuthor={highlightedAuthor}
              focusSha={focusSha}
              onSelect={setSelection}
              theme={theme}
              arrangement={arrangement}
              layout={layout}
              onShowFinished={() => changeShowFinished(true)}
            />
            <DetailsPanel
              repo={graph.repo}
              graph={graph}
              slots={slots}
              selection={selection}
              onSelectCommit={selectCommit}
            />
          </>
        ) : (
          <div className="welcome">
            {graph ? (
              <p>No commits in this time window. Try a longer window.</p>
            ) : syncing || loadingGraph ? (
              <p className="muted">Loading…</p>
            ) : (
              <>
                <h1>See what your team is doing in git</h1>
                <p>
                  Paste a GitHub repository URL above and press <strong>Load</strong>. Every branch, commit
                  and merge appears as a graph; click anything for details.
                </p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
