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
  toFlowEdges,
  toFlowNodes,
  type CommitFlowNode,
  type GitFlowEdge,
} from '../lib/layout'
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
}

export function GraphPanel(props: GraphPanelProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  )
}

function GraphCanvas({ graph, slots, selection, highlightedAuthor, focusSha, onSelect }: GraphPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setViewport, setCenter, getZoom } = useReactFlow()
  const nodes = useMemo(
    () => toFlowNodes(graph, slots, selection, highlightedAuthor),
    [graph, slots, selection, highlightedAuthor],
  )
  const edges = useMemo(() => toFlowEdges(graph, selection), [graph, selection])

  const fit = useCallback(
    (duration = 0) => {
      const canvas = containerRef.current
      const viewport = fitViewport(graph, {
        width: canvas?.clientWidth ?? 1000,
        height: canvas?.clientHeight ?? 600,
        top: RULER_HEIGHT,
        left: FIRST_COMMIT_LEFT,
        right: RIGHT_PADDING,
      })
      void setViewport(viewport, { duration })
    },
    [graph, setViewport],
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
    const center = commitCenter(commit)
    setCenter(center.x, center.y, { zoom: Math.max(getZoom(), 0.8), duration: 400 })
  }, [focusSha, graph, setCenter, getZoom])

  const onNodeClick: NodeMouseHandler<CommitFlowNode> = (_, node) =>
    onSelect({ type: 'node', sha: node.id })
  const onEdgeClick: EdgeMouseHandler<GitFlowEdge> = (_, edge) =>
    onSelect({ type: 'edge', id: edge.id, source: edge.source, target: edge.target })

  return (
    <div className="graph-panel">
      <aside className="lane-column" aria-label="Branches">
        <LaneLabels graph={graph} />
        <div className="lane-column-header" style={{ height: RULER_HEIGHT }}>
          Branches <span className="lane-count">{graph.lanes.length}</span>
        </div>
      </aside>
      <div className="graph-canvas" ref={containerRef}>
        <LaneBands graph={graph} />
        <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => onSelect(null)}
        onMoveStart={(event) => {
          if (event) userMoved.current = true // null for programmatic moves
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.1}
        maxZoom={2.5}
        colorMode="system"
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

/** Alternating lane stripes and day separators, drawn behind the graph and kept in sync with it. */
function LaneBands({ graph }: { graph: Graph }) {
  const { x, y, zoom } = useViewport()
  return (
    <div className="lane-bands" aria-hidden>
      {graph.lanes.map((lane) => (
        <div
          key={lane.id}
          className={`lane-band${lane.id % 2 ? ' is-odd' : ''}`}
          style={{ top: y + (lane.id - 0.5) * LANE_HEIGHT * zoom, height: LANE_HEIGHT * zoom }}
        />
      ))}
      {dayBoundaries(graph).map(({ x: graphX, key }) => (
        <div key={key} className="day-line" style={{ left: x + graphX * zoom }} />
      ))}
    </div>
  )
}

/** The fixed branch column: one row per lane, following the graph as you pan and zoom
 *  vertically, but never moving sideways, so names never cover commits. */
function LaneLabels({ graph }: { graph: Graph }) {
  const { y, zoom } = useViewport()
  const visible = skipCrowded(graph.lanes, (lane) => y + lane.id * LANE_HEIGHT * zoom, MIN_LABEL_GAP)
  return (
    <div className="lane-labels">
      {graph.lanes.map((lane) => (
        <div
          key={`row-${lane.id}`}
          className={`lane-row${lane.id % 2 ? ' is-odd' : ''}`}
          style={{ top: y + (lane.id - 0.5) * LANE_HEIGHT * zoom, height: LANE_HEIGHT * zoom }}
          aria-hidden
        />
      ))}
      {visible.map(({ item: lane, position }) => (
        <div
          key={lane.id}
          className={`lane-label kind-${lane.kind}`}
          style={{ top: position }}
          title={`${lane.name} · ${lane.commit_count} commit${lane.commit_count === 1 ? '' : 's'} in this lane`}
        >
          <span className="lane-name">{lane.name}</span>
          {LANE_KIND_LABEL[lane.kind] && (
            <span className="lane-kind">{LANE_KIND_LABEL[lane.kind]}</span>
          )}
        </div>
      ))}
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
