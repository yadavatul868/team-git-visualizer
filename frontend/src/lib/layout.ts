import type { Edge, Node } from '@xyflow/react'

import type { EdgeKind, Graph, GraphNode, Selection } from '../types'
import { authorColor, type AuthorSlots } from './colors'
import { initials } from './format'
import type { Blob, Compaction } from './compact'
import type { Arrangement } from './rows'

/** Horizontal distance between consecutive commits. */
export const COLUMN_WIDTH = 120
/** Vertical distance between rows (one row per branch, plus one for folded branches). */
export const LANE_HEIGHT = 96
/** Diameter of a commit dot. */
export const NODE_SIZE = 30
/** Size of a blob (a collapsed run of commits). */
export const BLOB_WIDTH = 50
export const BLOB_HEIGHT = 30
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
  sourceSha: string
  targetSha: string
}

export interface BlobNodeData extends Record<string, unknown> {
  blob: Blob
  color: string
  initials: string
  selected: boolean
  dimmed: boolean
  folded: boolean
}

export type CommitFlowNode = Node<CommitNodeData, 'commit'>
export type BlobFlowNode = Node<BlobNodeData, 'blob'>
export type GraphFlowNode = CommitFlowNode | BlobFlowNode
export type GitFlowEdge = Edge<GitEdgeData, 'git'>

/** Graph x of a column. */
export const columnX = (column: number): number => ORIGIN_X + column * COLUMN_WIDTH

/** Centre of a commit (or of the blob it's collapsed into) in graph coordinates. */
export function commitCenter(
  commit: Pick<GraphNode, 'sha' | 'lane'>,
  rowOf: Arrangement['rowOf'],
  compaction: Compaction,
): { x: number; y: number } {
  return {
    x: columnX(compaction.columnOf.get(commit.sha) ?? 0),
    y: (rowOf.get(commit.lane) ?? 0) * LANE_HEIGHT,
  }
}

export function toFlowNodes(
  arrangement: Arrangement,
  compaction: Compaction,
  slots: AuthorSlots,
  selection: Selection | null,
  highlightedAuthor: string | null,
): GraphFlowNode[] {
  const folded = new Set(
    arrangement.rows.flatMap((row) => (row.kind === 'finished' ? row.lanes.map((l) => l.id) : [])),
  )
  const y = (lane: number) => (arrangement.rowOf.get(lane) ?? 0) * LANE_HEIGHT
  return compaction.units.map((unit, column): GraphFlowNode => {
    if (unit.kind === 'blob') {
      const { blob } = unit
      const author = blob.commits[0].author
      return {
        id: blob.id,
        type: 'blob',
        position: { x: columnX(column) - BLOB_WIDTH / 2, y: y(blob.lane) - BLOB_HEIGHT / 2 },
        width: BLOB_WIDTH,
        height: BLOB_HEIGHT,
        draggable: false,
        connectable: false,
        className: `author-node-${slots[author.key] ?? 'other'}`,
        data: {
          blob,
          color: authorColor(slots, author.key),
          initials: initials(author.name),
          selected: selection?.type === 'blob' && selection.id === blob.id,
          dimmed: highlightedAuthor !== null && author.key !== highlightedAuthor,
          folded: folded.has(blob.lane),
        },
      }
    }
    const { commit } = unit
    return {
      id: commit.sha,
      type: 'commit',
      position: { x: columnX(column) - NODE_SIZE / 2, y: y(commit.lane) - NODE_SIZE / 2 },
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

export function toFlowEdges(
  graph: Graph,
  compaction: Compaction,
  selection: Selection | null,
): GitFlowEdge[] {
  const edges: GitFlowEdge[] = []
  for (const edge of graph.edges) {
    const source = compaction.unitIdOf.get(edge.source) ?? edge.source
    const target = compaction.unitIdOf.get(edge.target) ?? edge.target
    if (source === target) continue // inside a blob
    const selected = selection?.type === 'edge' && selection.id === edge.id
    edges.push({
      id: edge.id,
      type: 'git',
      source,
      target,
      className: `edge-${edge.kind}${selected ? ' is-selected' : ''}`,
      zIndex: selected ? 1 : 0,
      // The real commits at each end, for the details panel (the flow ends may be blobs).
      data: { kind: edge.kind, sourceSha: edge.source, targetSha: edge.target },
    })
  }
  return edges
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
 * as far out as MAX_LANES_IN_FIT rows, showing the newest commits: centred on the default
 * branch in the centered layout, otherwise the top rows (scrolled down just enough that the row
 * with the newest commit is in view).
 */
export function fitViewport(
  graph: Graph,
  arrangement: Arrangement,
  compaction: Compaction,
  { width, height, top, left, right }: FitOptions,
): { x: number; y: number; zoom: number } {
  const span = Math.max(1, compaction.units.length - 1) * COLUMN_WIDTH
  const usableHeight = Math.max(1, height - top - LANE_HEIGHT * 0.25)
  const fitWidth = (width - left - right) / span
  const fitHeight = usableHeight / (Math.max(1, arrangement.rows.length) * LANE_HEIGHT)
  const readable = usableHeight / (MAX_LANES_IN_FIT * LANE_HEIGHT)
  const zoom = Math.min(1, Math.max(Math.min(fitWidth, fitHeight), readable))
  const fitsHorizontally = span * zoom <= width - left - right
  const rowsInView = Math.max(1, Math.floor(usableHeight / (LANE_HEIGHT * zoom)))
  const newest = graph.nodes.at(-1)
  const newestRow = newest ? (arrangement.rowOf.get(newest.lane) ?? 0) : 0
  const lastFirstRow = Math.max(0, arrangement.rows.length - rowsInView)
  const firstRow =
    arrangement.anchorRow !== null && rowsInView < arrangement.rows.length
      ? // Centered layout: keep the default branch in the middle of the view.
        Math.min(lastFirstRow, Math.max(0, arrangement.anchorRow - Math.floor(rowsInView / 2)))
      : Math.max(0, newestRow - rowsInView + 1)
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
  compaction: Compaction,
  laneId: number,
  { width, height, top }: Pick<FitOptions, 'width' | 'height' | 'top'>,
  zoom: number,
  placement: 'top' | 'middle',
): { x: number; y: number; zoom: number } {
  const newest = graph.nodes.filter((node) => node.lane === laneId).at(-1) // nodes are oldest → newest
  const centerX = newest ? commitCenter(newest, arrangement.rowOf, compaction).x : ORIGIN_X
  const row = arrangement.rowOf.get(laneId) ?? 0
  const screenY = placement === 'middle' ? top + (height - top) / 2 : top + 0.6 * LANE_HEIGHT * zoom
  return {
    x: width / 2 - centerX * zoom,
    y: screenY - row * LANE_HEIGHT * zoom,
    zoom,
  }
}
