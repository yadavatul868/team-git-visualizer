import type { Edge, Node } from '@xyflow/react'

import type { EdgeKind, Graph, GraphNode, Selection } from '../types'
import { authorColor, type AuthorSlots } from './colors'
import { initials } from './format'
import type { Arrangement } from './rows'

/** Horizontal distance between consecutive commits. */
export const COLUMN_WIDTH = 120
/** Vertical distance between rows (one row per branch, plus one for folded branches). */
export const LANE_HEIGHT = 96
/** Diameter of a commit dot. */
export const NODE_SIZE = 30
/** Graph x of the first commit, leaving room for the sticky lane labels at zoom 1. */
export const ORIGIN_X = 210

export interface CommitNodeData extends Record<string, unknown> {
  commit: GraphNode
  color: string
  initials: string
  selected: boolean
  dimmed: boolean
  /** On a folded (finished) branch: drawn smaller and quieter. */
  folded: boolean
}

export interface GitEdgeData extends Record<string, unknown> {
  kind: EdgeKind
}

export type CommitFlowNode = Node<CommitNodeData, 'commit'>
export type GitFlowEdge = Edge<GitEdgeData, 'git'>

/** Centre of a commit in graph coordinates. */
export function commitCenter(
  commit: Pick<GraphNode, 'x' | 'lane'>,
  rowOf: Arrangement['rowOf'],
): { x: number; y: number } {
  return { x: ORIGIN_X + commit.x * COLUMN_WIDTH, y: (rowOf.get(commit.lane) ?? 0) * LANE_HEIGHT }
}

export function toFlowNodes(
  graph: Graph,
  arrangement: Arrangement,
  slots: AuthorSlots,
  selection: Selection | null,
  highlightedAuthor: string | null,
): CommitFlowNode[] {
  const folded = new Set(
    arrangement.rows.flatMap((row) => (row.kind === 'finished' ? row.lanes.map((l) => l.id) : [])),
  )
  return graph.nodes.map((commit) => {
    const center = commitCenter(commit, arrangement.rowOf)
    return {
      id: commit.sha,
      type: 'commit',
      position: { x: center.x - NODE_SIZE / 2, y: center.y - NODE_SIZE / 2 },
      width: NODE_SIZE,
      height: NODE_SIZE,
      draggable: false,
      connectable: false,
      className: `author-node-${slots[commit.author.key] ?? 'other'}`,
      data: {
        commit,
        color: authorColor(slots, commit.author.key),
        initials: initials(commit.author.name),
        selected: selection?.type === 'node' && selection.sha === commit.sha,
        dimmed: highlightedAuthor !== null && commit.author.key !== highlightedAuthor,
        folded: folded.has(commit.lane),
      },
    }
  })
}

export function toFlowEdges(graph: Graph, selection: Selection | null): GitFlowEdge[] {
  return graph.edges.map((edge) => {
    const selected = selection?.type === 'edge' && selection.id === edge.id
    return {
      id: edge.id,
      type: 'git',
      source: edge.source,
      target: edge.target,
      className: `edge-${edge.kind}${selected ? ' is-selected' : ''}`,
      zIndex: selected ? 1 : 0,
      data: { kind: edge.kind },
    }
  })
}

/** SVG path for an edge, drawn like a git graph rather than a generic curve:
 *  a branch-off leaves its parent lane right away, a merge travels along its own lane and
 *  joins the target lane just before the merge commit. */
export function gitEdgePath(
  kind: EdgeKind,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  if (Math.abs(sourceY - targetY) < 1) return `M ${sourceX},${sourceY} L ${targetX},${targetY}`
  const bend = Math.min(COLUMN_WIDTH * 0.7, targetX - sourceX)
  if (kind === 'merge') {
    const start = targetX - bend
    return `M ${sourceX},${sourceY} L ${start},${sourceY} C ${start + bend / 2},${sourceY} ${start + bend / 2},${targetY} ${targetX},${targetY}`
  }
  const end = sourceX + bend
  return `M ${sourceX},${sourceY} C ${sourceX + bend / 2},${sourceY} ${sourceX + bend / 2},${targetY} ${end},${targetY} L ${targetX},${targetY}`
}

/** Fit view never zooms out further than this many rows filling the graph's height. */
export const MAX_LANES_IN_FIT = 7

export interface FitOptions {
  width: number
  height: number
  /** Space reserved above the first lane (the date ruler). */
  top: number
  /** Screen x of the oldest commit when everything fits horizontally. */
  left: number
  right: number
}

/**
 * The "fit view" viewport: show everything when that keeps lanes readable, otherwise zoom only
 * as far out as MAX_LANES_IN_FIT lanes, showing the newest commits and the top lanes (scrolled
 * down just enough that the lane with the newest commit is in view).
 */
export function fitViewport(
  graph: Graph,
  arrangement: Arrangement,
  { width, height, top, left, right }: FitOptions,
): { x: number; y: number; zoom: number } {
  const span = Math.max(1, graph.nodes.length - 1) * COLUMN_WIDTH
  const usableHeight = Math.max(1, height - top - LANE_HEIGHT * 0.25)
  const fitWidth = (width - left - right) / span
  const fitHeight = usableHeight / (Math.max(1, arrangement.rows.length) * LANE_HEIGHT)
  const readable = usableHeight / (MAX_LANES_IN_FIT * LANE_HEIGHT)
  const zoom = Math.min(1, Math.max(Math.min(fitWidth, fitHeight), readable))
  const fitsHorizontally = span * zoom <= width - left - right
  const rowsInView = Math.max(1, Math.floor(usableHeight / (LANE_HEIGHT * zoom)))
  const newest = graph.nodes.at(-1)
  const newestRow = newest ? (arrangement.rowOf.get(newest.lane) ?? 0) : 0
  const firstRow = Math.max(0, newestRow - rowsInView + 1)
  return {
    x: fitsHorizontally ? left - ORIGIN_X * zoom : width - right - (ORIGIN_X + span) * zoom,
    y: top + (0.6 - firstRow) * LANE_HEIGHT * zoom,
    zoom,
  }
}

/** Viewport bringing a lane into view (as the top row, or mid-height for the centred layout)
 *  with its newest commit centred horizontally. */
export function laneViewport(
  graph: Graph,
  arrangement: Arrangement,
  laneId: number,
  { width, height, top }: Pick<FitOptions, 'width' | 'height' | 'top'>,
  zoom: number,
  placement: 'top' | 'middle',
): { x: number; y: number; zoom: number } {
  const newest = graph.nodes.filter((node) => node.lane === laneId).at(-1) // nodes are oldest → newest
  const centerX = newest ? commitCenter(newest, arrangement.rowOf).x : ORIGIN_X
  const row = arrangement.rowOf.get(laneId) ?? 0
  const screenY = placement === 'middle' ? top + (height - top) / 2 : top + 0.6 * LANE_HEIGHT * zoom
  return {
    x: width / 2 - centerX * zoom,
    y: screenY - row * LANE_HEIGHT * zoom,
    zoom,
  }
}
