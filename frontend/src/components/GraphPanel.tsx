import {
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useViewport,
  type EdgeMouseHandler,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import type { AuthorSlots } from '../lib/colors'
import { LEVELS, compact, levelForZoom, zoomToExpand, type Compaction } from '../lib/compact'
import { dayKey, formatDay } from '../lib/format'
import {
  COLUMN_WIDTH,
  LANE_HEIGHT,
  ORIGIN_X,
  columnX,
  commitCenter,
  fitViewport,
  laneViewport,
  toFlowEdges,
  toFlowNodes,
  type GitFlowEdge,
  type GraphFlowNode,
} from '../lib/layout'
import type { Arrangement, LaneLayout } from '../lib/rows'
import type { Theme } from '../lib/theme'
import type { Graph, Selection } from '../types'
import { BlobNode } from './BlobNode'
import { CommitNode } from './CommitNode'
import { GitEdge } from './GitEdge'

const nodeTypes = { commit: CommitNode, blob: BlobNode }
const edgeTypes = { git: GitEdge }
const RULER_HEIGHT = 34
/** Screen x (inside the graph area) of the oldest commit when the whole graph fits. */
const FIRST_COMMIT_LEFT = 70
const RIGHT_PADDING = 110
const MIN_LABEL_GAP = 26
const MIN_DAY_GAP = 84
/** Jumping to a branch zooms in at least this far, so its commits are readable. */
const MIN_JUMP_ZOOM = 0.7
const LANE_KIND_LABEL: Record<string, string> = {
  default: 'default',
  deleted: 'deleted',
  unlabelled: 'unknown',
}

interface GraphPanelProps {
  graph: Graph
  slots: AuthorSlots
  selection: Selection | null
  highlightedAuthor: string | null
  focusSha: string | null
  onSelect: (selection: Selection | null) => void
  theme: Theme
  arrangement: Arrangement
  layout: LaneLayout
  onShowFinished: () => void
}

export function GraphPanel(props: GraphPanelProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  )
}

/** Commits that must stay visible (never collapse into a blob): the selection and its ends. */
function keptCommits(selection: Selection | null, focusSha: string | null): Set<string> {
  const keep = new Set<string>()
  if (focusSha) keep.add(focusSha)
  if (selection?.type === 'node') keep.add(selection.sha)
  if (selection?.type === 'edge') {
    keep.add(selection.source)
    keep.add(selection.target)
  }
  return keep
}

function GraphCanvas({
  graph,
  slots,
  selection,
  highlightedAuthor,
  focusSha,
  onSelect,
  theme,
  arrangement,
  layout,
  onShowFinished,
}: GraphPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setViewport, setCenter, getZoom, getViewport } = useReactFlow()
  const columnRef = useRef<HTMLElement>(null)

  // Zoom level → how much of the time axis is compacted (see lib/compact.ts).
  // Subscribing to the level (not the raw zoom) re-renders only when a level boundary is
  // crossed; the ref carries the current level for the hysteresis.
  const levelRef = useRef(0)
  const level = useStore(
    useCallback((state: { transform: [number, number, number] }) => levelForZoom(state.transform[2], levelRef.current), []),
  )
  useEffect(() => {
    levelRef.current = level
  }, [level])

  const keep = useMemo(() => keptCommits(selection, focusSha), [selection, focusSha])
  const compaction = useMemo(
    () => compact(graph, LEVELS[level].minRun, keep),
    [graph, level, keep],
  )
  const nodes = useMemo(
    () => toFlowNodes(arrangement, compaction, slots, selection, highlightedAuthor),
    [arrangement, compaction, slots, selection, highlightedAuthor],
  )
  const edges = useMemo(
    () => toFlowEdges(graph, compaction, selection),
    [graph, compaction, selection],
  )

  const days = useMemo(() => dayBoundaries(compaction), [compaction])

  const canvasSize = () => ({
    width: containerRef.current?.clientWidth ?? 1000,
    height: containerRef.current?.clientHeight ?? 600,
  })

  const fit = useCallback(
    (duration = 0) => {
      const options = { ...canvasSize(), top: RULER_HEIGHT, left: FIRST_COMMIT_LEFT, right: RIGHT_PADDING }
      // Pick the most detailed level whose own fit zoom lands in that level.
      let chosen = { viewport: { x: 0, y: 0, zoom: 1 } }
      for (let index = 0; index < LEVELS.length; index++) {
        const candidate = compact(graph, LEVELS[index].minRun, new Set())
        const viewport = fitViewport(graph, arrangement, candidate, options)
        chosen = { viewport }
        if (levelForZoom(viewport.zoom) === index) break
      }
      // The zoom level (and so the compaction) follows from the zoom this viewport sets.
      void setViewport(chosen.viewport, { duration })
    },
    [graph, arrangement, setViewport],
  )

  // Every newly loaded graph starts in the fit view, and stays fitted while the graph area
  // changes size (layout settling, window resizes), until you pan or zoom yourself.
  const userMoved = useRef(false)
  useEffect(() => {
    userMoved.current = false
    fit()
    const canvas = containerRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      if (!userMoved.current) fit()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [fit])

  // When the zoom level changes the columns shift; keep the commit at the centre of the screen
  // where it was, so blobs open and close in place. A blob click instead centres on that blob.
  const previous = useRef<Compaction | null>(null)
  const pendingFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = compaction
    const { x, y, zoom: currentZoom } = getViewport()
    if (pendingFocus.current) {
      const commit = graph.nodes.find((node) => node.sha === pendingFocus.current)
      pendingFocus.current = null
      if (commit) {
        const center = commitCenter(commit, arrangement.rowOf, compaction)
        void setCenter(center.x, center.y, { zoom: currentZoom, duration: 300 })
      }
      return
    }
    if (!before || before === compaction || before.minRun === compaction.minRun) return
    const { width } = canvasSize()
    const centerX = (width / 2 - x) / currentZoom
    const column = Math.min(
      before.units.length - 1,
      Math.max(0, Math.round((centerX - ORIGIN_X) / COLUMN_WIDTH)),
    )
    const unit = before.units[column]
    if (!unit) return
    const sha = unit.kind === 'blob' ? unit.blob.commits[0].sha : unit.commit.sha
    const shift = columnX(compaction.columnOf.get(sha) ?? column) - columnX(column)
    void setViewport({ x: x - shift * currentZoom, y, zoom: currentZoom })
  }, [compaction, graph, arrangement, getViewport, setViewport, setCenter])

  // Centre on a commit when asked (e.g. a parent clicked in the details panel), once per request.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focusSha || focused.current === focusSha) return
    const commit = graph.nodes.find((node) => node.sha === focusSha)
    if (!commit) return
    focused.current = focusSha
    const center = commitCenter(commit, arrangement.rowOf, compaction)
    void setCenter(center.x, center.y, { zoom: Math.max(getZoom(), 0.8), duration: 400 })
  }, [focusSha, graph, arrangement, compaction, setCenter, getZoom])

  /** Jump to a branch: its lane becomes the top row, its newest commit centred. */
  const goToLane = (laneId: number) => {
    userMoved.current = true
    const jumpZoom = Math.max(getZoom(), MIN_JUMP_ZOOM)
    const placement = layout === 'centered' ? 'middle' : 'top'
    const viewport = laneViewport(
      graph,
      arrangement,
      compaction,
      laneId,
      { ...canvasSize(), top: RULER_HEIGHT },
      jumpZoom,
      placement,
    )
    void setViewport(viewport, { duration: 350 })
  }
  const defaultLane = graph.lanes.find((lane) => lane.kind === 'default')

  // Scrolling over the branch column scrolls the diagram too (non-passive so the page stays put).
  useEffect(() => {
    const column = columnRef.current
    if (!column) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      userMoved.current = true
      const { x, y, zoom: currentZoom } = getViewport()
      void setViewport({ x, y: y - event.deltaY, zoom: currentZoom })
    }
    column.addEventListener('wheel', onWheel, { passive: false })
    return () => column.removeEventListener('wheel', onWheel)
  }, [getViewport, setViewport])

  const onNodeClick: NodeMouseHandler<GraphFlowNode> = (_, node) => {
    if (node.type !== 'blob') {
      onSelect({ type: 'node', sha: node.id })
      return
    }
    // Clicking a blob opens it: zoom in just enough for its commits to show, centred on it.
    const { commits } = node.data.blob
    onSelect({ type: 'blob', id: node.id, shas: commits.map((commit) => commit.sha) })
    userMoved.current = true
    const targetZoom = Math.max(getZoom(), zoomToExpand(commits.length))
    levelRef.current = levelForZoom(targetZoom)
    pendingFocus.current = commits[Math.floor(commits.length / 2)].sha
    const { x, y } = getViewport()
    void setViewport({ x, y, zoom: targetZoom })
  }
  const onEdgeClick: EdgeMouseHandler<GitFlowEdge> = (_, edge) =>
    onSelect({
      type: 'edge',
      id: edge.id,
      source: edge.data?.sourceSha ?? edge.source,
      target: edge.data?.targetSha ?? edge.target,
    })

  return (
    <div className="graph-panel">
      <aside className="lane-column" aria-label="Branches" ref={columnRef}>
        <LaneLabels
          graph={graph}
          arrangement={arrangement}
          layout={layout}
          onSelectLane={goToLane}
          onShowFinished={onShowFinished}
        />
        <div className="lane-column-header" style={{ height: RULER_HEIGHT }}>
          Branches <span className="lane-count">{graph.lanes.length}</span>
          {defaultLane && (
            <button
              type="button"
              className="lane-home"
              onClick={() => goToLane(defaultLane.id)}
              title={`Center on the default branch (${defaultLane.name})`}
            >
              <span aria-hidden>⌂</span> {defaultLane.name}
            </button>
          )}
        </div>
      </aside>
      <div className="graph-canvas" ref={containerRef}>
        <LaneBands days={days} arrangement={arrangement} />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => onSelect(null)}
          panOnScroll
          panOnScrollSpeed={1}
          zoomOnScroll={false}
          onMoveStart={(event) => {
            if (event) userMoved.current = true // null for programmatic moves
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          minZoom={0.1}
          maxZoom={2.5}
          colorMode={theme}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} showFitView={false} position="bottom-left">
            <ControlButton
              onClick={() => {
                userMoved.current = false
                fit(300)
              }}
              title="Fit view"
              aria-label="Fit view"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                <path
                  d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
              </svg>
            </ControlButton>
          </Controls>
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeClassName={(node) => (node.className ?? '') + ' minimap-node'}
            nodeBorderRadius={20}
            maskColor="var(--minimap-mask)"
          />
        </ReactFlow>
        <DateRuler days={days} />
      </div>
    </div>
  )
}

type DayBoundary = { x: number; key: string; label: string }

/** Row indices currently on screen (plus one either side), so off-screen rows aren't drawn. */
function useVisibleRows(rowCount: number): [number, number] {
  const { y, zoom } = useViewport()
  const height = useStore((state) => state.height)
  const rowHeight = LANE_HEIGHT * zoom
  const first = Math.max(0, Math.floor(-y / rowHeight) - 1)
  const last = Math.min(rowCount - 1, Math.ceil((height - y) / rowHeight) + 1)
  return [first, last]
}

/** Alternating row stripes and day separators, drawn behind the graph and kept in sync with it. */
const LaneBands = memo(function LaneBands({
  days,
  arrangement,
}: {
  days: DayBoundary[]
  arrangement: Arrangement
}) {
  const { x, y, zoom } = useViewport()
  const width = useStore((state) => state.width)
  const [first, last] = useVisibleRows(arrangement.rows.length)
  return (
    <div className="lane-bands" aria-hidden>
      {arrangement.rows.slice(first, last + 1).map((row, offset) => {
        const index = first + offset
        return (
          <div
            key={index}
            className={`lane-band${index % 2 ? ' is-odd' : ''}${row.kind === 'finished' ? ' is-finished' : ''}`}
            style={{ top: y + (index - 0.5) * LANE_HEIGHT * zoom, height: LANE_HEIGHT * zoom }}
          />
        )
      })}
      {days
        .filter(({ x: graphX }) => {
          const left = x + graphX * zoom
          return left >= 0 && left <= width
        })
        .map(({ x: graphX, key }) => (
          <div key={key} className="day-line" style={{ left: x + graphX * zoom }} />
        ))}
    </div>
  )
})

/** Indentation per family-tree level in the top-down layout (capped so deep trees still fit). */
const INDENT_PX = 12
const MAX_INDENT_LEVELS = 5
/** Below this on-screen row height there's only room for the branch name, not its origin. */
const MIN_ROW_HEIGHT_FOR_ORIGIN = 56

/** The fixed branch column (only on-screen rows are drawn): one row per lane, following the graph as you pan and zoom
 *  vertically, but never moving sideways, so names never cover commits. Under each name, a
 *  second line says which branch it came from, with an arrow pointing to that branch's row. */
const LaneLabels = memo(function LaneLabels({
  graph,
  arrangement,
  layout,
  onSelectLane,
  onShowFinished,
}: {
  graph: Graph
  arrangement: Arrangement
  layout: LaneLayout
  onSelectLane: (laneId: number) => void
  onShowFinished: () => void
}) {
  const { y, zoom } = useViewport()
  const showOrigin = LANE_HEIGHT * zoom >= MIN_ROW_HEIGHT_FOR_ORIGIN
  const [first, last] = useVisibleRows(arrangement.rows.length)
  const rows = arrangement.rows
    .slice(first, last + 1)
    .map((row, offset) => ({ row, index: first + offset }))
  const visible = skipCrowded(rows, ({ index }) => y + index * LANE_HEIGHT * zoom, MIN_LABEL_GAP)
  return (
    <div className="lane-labels">
      {rows.map(({ row, index }) => (
        <div
          key={`row-${index}`}
          className={`lane-row${index % 2 ? ' is-odd' : ''}${row.kind === 'finished' ? ' is-finished' : ''}`}
          style={{ top: y + (index - 0.5) * LANE_HEIGHT * zoom, height: LANE_HEIGHT * zoom }}
          aria-hidden
        />
      ))}
      {visible.map(({ item: { row }, position }) => {
        if (row.kind === 'finished') {
          return (
            <button
              type="button"
              key="finished"
              className="lane-label finished-label"
              style={{ top: position }}
              onClick={onShowFinished}
              title={`${row.lanes.length} merged branches folded into this row: ${row.lanes
                .map((lane) => lane.name)
                .join(', ')}. Click to show them.`}
            >
              <span aria-hidden>▸</span>
              <span className="lane-name">
                {row.lanes.length} merged branch{row.lanes.length === 1 ? '' : 'es'}
              </span>
            </button>
          )
        }
        const lane = row.lane
        const indent =
          layout === 'top-down' ? Math.min(lane.depth, MAX_INDENT_LEVELS) * INDENT_PX : 0
        const parent = lane.parent !== null ? graph.lanes[lane.parent] : undefined
        const parentRow = lane.parent !== null ? arrangement.rowOf.get(lane.parent) : undefined
        const thisRow = arrangement.rowOf.get(lane.id) ?? 0
        const arrow = parentRow === undefined ? '' : parentRow < thisRow ? '↑' : '↓'
        return (
          <button
            type="button"
            key={lane.id}
            className={`lane-label kind-${lane.kind}${lane.finished ? ' is-finished' : ''}`}
            style={{ top: position, marginLeft: indent, maxWidth: `calc(100% - ${24 + indent}px)` }}
            onClick={() => onSelectLane(lane.id)}
            title={`${lane.name}${parent ? ` · branched off ${parent.name}` : ''} · ${lane.commit_count} commit${lane.commit_count === 1 ? '' : 's'} in this lane · click to jump to its latest commit`}
          >
            <span className="lane-title">
              <span className="lane-name">{lane.name}</span>
              {LANE_KIND_LABEL[lane.kind] && (
                <span className="lane-kind">{LANE_KIND_LABEL[lane.kind]}</span>
              )}
              {lane.finished && lane.kind === 'branch' && <span className="lane-kind">merged</span>}
              {lane.long_lived && lane.kind !== 'default' && (
                <span className="lane-kind" title="Long-lived branch: kept together with the default branch">
                  long-lived
                </span>
              )}
            </span>
            {showOrigin && lane.commit_count === 0 && lane.last_commit_at ? (
              <span className="lane-origin">no commits in window · last {formatDay(lane.last_commit_at)}</span>
            ) : (
              parent &&
              showOrigin && (
                <span className="lane-origin">
                  <span aria-hidden>{arrow}</span> from {parent.name}
                </span>
              )
            )}
          </button>
        )
      })}
    </div>
  )
})

/** Day labels along the top, marking where each calendar day starts. */
const DateRuler = memo(function DateRuler({ days }: { days: DayBoundary[] }) {
  const { x, zoom } = useViewport()
  const width = useStore((state) => state.width)
  const onScreen = days.filter(({ x: graphX }) => {
    const left = x + graphX * zoom
    return left >= -200 && left <= width
  })
  const visible = skipCrowded(onScreen, (day) => x + day.x * zoom, MIN_DAY_GAP)
  return (
    <div className="date-ruler" aria-hidden style={{ height: RULER_HEIGHT }}>
      {visible.map(({ item: day, position }) => (
        <span key={day.key} className="day-tick" style={{ left: position }}>
          {day.label}
        </span>
      ))}
    </div>
  )
})

/** Keep items at least `gap` px apart on screen (in order), so labels never pile up when zoomed out. */
function skipCrowded<T>(items: T[], positionOf: (item: T) => number, gap: number) {
  const kept: { item: T; position: number }[] = []
  for (const item of items) {
    const position = positionOf(item)
    const previous = kept.at(-1)
    if (!previous || position - previous.position >= gap) kept.push({ item, position })
  }
  return kept
}

/** Where each calendar day starts along the (possibly compacted) time axis. A blob counts from
 *  its first commit, so days entirely inside a blob get no tick. */
function dayBoundaries(compaction: Compaction): DayBoundary[] {
  const boundaries = []
  let previous = ''
  for (const [column, unit] of compaction.units.entries()) {
    const commit = unit.kind === 'blob' ? unit.blob.commits[0] : unit.commit
    const key = dayKey(commit.committed_at)
    if (key !== previous) {
      boundaries.push({
        x: ORIGIN_X + (column - 0.5) * COLUMN_WIDTH,
        key,
        label: formatDay(commit.committed_at),
      })
      previous = key
    }
  }
  return boundaries
}
