import {
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type EdgeMouseHandler,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { AuthorSlots } from '../lib/colors'
import { dayKey, formatDay } from '../lib/format'
import {
  COLUMN_WIDTH,
  LANE_HEIGHT,
  ORIGIN_X,
  commitCenter,
  fitViewport,
  laneViewport,
  toFlowEdges,
  toFlowNodes,
  type CommitFlowNode,
  type GitFlowEdge,
} from '../lib/layout'
import type { Arrangement, LaneLayout } from '../lib/rows'
import type { Theme } from '../lib/theme'
import type { Graph, Selection } from '../types'
import { CommitNode } from './CommitNode'
import { GitEdge } from './GitEdge'

const nodeTypes = { commit: CommitNode }
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
  const nodes = useMemo(
    () => toFlowNodes(graph, arrangement, slots, selection, highlightedAuthor),
    [graph, arrangement, slots, selection, highlightedAuthor],
  )
  const edges = useMemo(() => toFlowEdges(graph, selection), [graph, selection])

  const fit = useCallback(
    (duration = 0) => {
      const canvas = containerRef.current
      const viewport = fitViewport(graph, arrangement, {
        width: canvas?.clientWidth ?? 1000,
        height: canvas?.clientHeight ?? 600,
        top: RULER_HEIGHT,
        left: FIRST_COMMIT_LEFT,
        right: RIGHT_PADDING,
      })
      void setViewport(viewport, { duration })
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

  // Centre on a commit when asked (e.g. a parent clicked in the details panel).
  useEffect(() => {
    const commit = focusSha ? graph.nodes.find((node) => node.sha === focusSha) : undefined
    if (!commit) return
    const center = commitCenter(commit, arrangement.rowOf)
    setCenter(center.x, center.y, { zoom: Math.max(getZoom(), 0.8), duration: 400 })
  }, [focusSha, graph, arrangement, setCenter, getZoom])

  /** Jump to a branch: its lane becomes the top row, its newest commit centred. */
  const goToLane = (laneId: number) => {
    userMoved.current = true
    const zoom = Math.max(getZoom(), MIN_JUMP_ZOOM)
    const canvas = containerRef.current
    const size = { width: canvas?.clientWidth ?? 1000, height: canvas?.clientHeight ?? 600 }
    const placement = layout === 'centered' ? 'middle' : 'top'
    const viewport = laneViewport(graph, arrangement, laneId, { ...size, top: RULER_HEIGHT }, zoom, placement)
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
      const { x, y, zoom } = getViewport()
      void setViewport({ x, y: y - event.deltaY, zoom })
    }
    column.addEventListener('wheel', onWheel, { passive: false })
    return () => column.removeEventListener('wheel', onWheel)
  }, [getViewport, setViewport])

  const onNodeClick: NodeMouseHandler<CommitFlowNode> = (_, node) =>
    onSelect({ type: 'node', sha: node.id })
  const onEdgeClick: EdgeMouseHandler<GitFlowEdge> = (_, edge) =>
    onSelect({ type: 'edge', id: edge.id, source: edge.source, target: edge.target })

  return (
    <div className="graph-panel">
      <aside className="lane-column" aria-label="Branches" ref={columnRef}>
        <LaneLabels arrangement={arrangement} onSelectLane={goToLane} onShowFinished={onShowFinished} />
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
        <LaneBands graph={graph} arrangement={arrangement} />
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
        <DateRuler graph={graph} />
      </div>
    </div>
  )
}

/** Alternating row stripes and day separators, drawn behind the graph and kept in sync with it. */
function LaneBands({ graph, arrangement }: { graph: Graph; arrangement: Arrangement }) {
  const { x, y, zoom } = useViewport()
  return (
    <div className="lane-bands" aria-hidden>
      {arrangement.rows.map((row, index) => (
        <div
          key={index}
          className={`lane-band${index % 2 ? ' is-odd' : ''}${row.kind === 'finished' ? ' is-finished' : ''}`}
          style={{ top: y + (index - 0.5) * LANE_HEIGHT * zoom, height: LANE_HEIGHT * zoom }}
        />
      ))}
      {dayBoundaries(graph).map(({ x: graphX, key }) => (
        <div key={key} className="day-line" style={{ left: x + graphX * zoom }} />
      ))}
    </div>
  )
}

/** Indentation per family-tree level in the branch column (capped so deep trees still fit). */
const INDENT_PX = 12
const MAX_INDENT_LEVELS = 5

/** The fixed branch column: one row per lane, following the graph as you pan and zoom
 *  vertically, but never moving sideways, so names never cover commits. Names are indented by
 *  their depth in the branch family tree. */
function LaneLabels({
  arrangement,
  onSelectLane,
  onShowFinished,
}: {
  arrangement: Arrangement
  onSelectLane: (laneId: number) => void
  onShowFinished: () => void
}) {
  const { y, zoom } = useViewport()
  const rows = arrangement.rows.map((row, index) => ({ row, index }))
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
        const indent = Math.min(lane.depth, MAX_INDENT_LEVELS) * INDENT_PX
        return (
          <button
            type="button"
            key={lane.id}
            className={`lane-label kind-${lane.kind}${lane.finished ? ' is-finished' : ''}`}
            style={{ top: position, marginLeft: indent, maxWidth: `calc(100% - ${24 + indent}px)` }}
            onClick={() => onSelectLane(lane.id)}
            title={`${lane.name} · ${lane.commit_count} commit${lane.commit_count === 1 ? '' : 's'} in this lane · click to jump to its latest commit`}
          >
            {lane.depth > 0 && (
              <span className="lane-branch-mark" aria-hidden>
                ↳
              </span>
            )}
            <span className="lane-name">{lane.name}</span>
            {LANE_KIND_LABEL[lane.kind] && (
              <span className="lane-kind">{LANE_KIND_LABEL[lane.kind]}</span>
            )}
            {lane.finished && lane.kind === 'branch' && <span className="lane-kind">merged</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Day labels along the top, marking where each calendar day starts. */
function DateRuler({ graph }: { graph: Graph }) {
  const { x, zoom } = useViewport()
  const visible = skipCrowded(dayBoundaries(graph), (day) => x + day.x * zoom, MIN_DAY_GAP)
  return (
    <div className="date-ruler" aria-hidden style={{ height: RULER_HEIGHT }}>
      {visible.map(({ item: day, position }) => (
        <span key={day.key} className="day-tick" style={{ left: position }}>
          {day.label}
        </span>
      ))}
    </div>
  )
}

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

function dayBoundaries(graph: Graph): { x: number; key: string; label: string }[] {
  const boundaries = []
  let previous = ''
  for (const node of graph.nodes) {
    const key = dayKey(node.committed_at)
    if (key !== previous) {
      boundaries.push({
        x: ORIGIN_X + (node.x - 0.5) * COLUMN_WIDTH,
        key,
        label: formatDay(node.committed_at),
      })
      previous = key
    }
  }
  return boundaries
}
