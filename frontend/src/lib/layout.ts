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
  /** Set when the two ends are on rows that aren't next to each other: instead of a long line
   *  crossing other branches' rows, draw a short labelled stub at each end. */
  jump?: {
    /** The other end is above (true) or below. Seen from the source commit. */
    targetAbove: boolean
    /** Branch shown at the source end ("→ dev") and at the target end ("← feature/x"). */
    targetBranch: string
    sourceBranch: string
    /** Position among jumps leaving the same commit / entering the same commit in the same
     *  direction, so their labels stack instead of overlapping. */
    sourceSlot: number
    targetSlot: number
  }
  onSelect?: () => void
  selected?: boolean
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

export function toFlowEdges(
  graph: Graph,
  arrangement: Arrangement,
  selection: Selection | null,
  onSelectEdge: (selection: Selection) => void,
): GitFlowEdge[] {
  const laneOf = new Map(graph.nodes.map((node) => [node.sha, node.lane]))
  const rowOfCommit = (sha: string) => arrangement.rowOf.get(laneOf.get(sha) ?? -1) ?? 0
  const laneName = (sha: string) => graph.lanes[laneOf.get(sha) ?? -1]?.name ?? 'another branch'

  const slots = new Map<string, number>()
  const nextSlot = (key: string) => {
    const slot = slots.get(key) ?? 0
    slots.set(key, slot + 1)
    return slot
  }

  return graph.edges.map((edge) => {
    const selected = selection?.type === 'edge' && selection.id === edge.id
    const sourceRow = rowOfCommit(edge.source)
    const targetRow = rowOfCommit(edge.target)
    const targetAbove = targetRow < sourceRow
    const jump =
      Math.abs(sourceRow - targetRow) > 1
        ? {
            targetAbove,
            targetBranch: laneName(edge.target),
            sourceBranch: laneName(edge.source),
            sourceSlot: nextSlot(`out:${edge.source}:${targetAbove}`),
            targetSlot: nextSlot(`in:${edge.target}:${targetAbove}`),
          }
        : undefined
    return {
      id: edge.id,
      type: 'git',
      source: edge.source,
      target: edge.target,
      className: `edge-${edge.kind}${jump ? ' is-jump' : ''}${selected ? ' is-selected' : ''}`,
      zIndex: selected ? 1 : 0,
      data: {
        kind: edge.kind,
        jump,
        selected,
        onSelect: () =>
          onSelectEdge({ type: 'edge', id: edge.id, source: edge.source, target: edge.target }),
      },
    }
  })
}

/** Jump stub shape: a short run out of the commit, then a lean towards the other row. Incoming
 *  stubs rise further than outgoing ones so labels of neighbouring commits don't collide. */
export const JUMP_STUB = { run: 12, lean: 22, outRise: 14, inRise: 32, slotGap: 22 }

/** SVG paths for the two stubs of a jump edge (see GitEdgeData.jump). */
export function jumpStubPaths(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  targetAbove: boolean,
  sourceSlot = 0,
  targetSlot = 0,
): { source: string; target: string; sourceTip: [number, number]; targetTip: [number, number] } {
  const { run, lean, outRise, inRise, slotGap } = JUMP_STUB
  const up = targetAbove ? -1 : 1
  const sourceTip: [number, number] = [
    sourceX + run + lean,
    sourceY + up * (outRise + sourceSlot * slotGap),
  ]
  const targetTip: [number, number] = [
    targetX - run - lean,
    targetY - up * (inRise + targetSlot * slotGap),
  ]
  return {
    source: `M ${sourceX},${sourceY} L ${sourceX + run},${sourceY} L ${sourceTip[0]},${sourceTip[1]}`,
    target: `M ${targetTip[0]},${targetTip[1]} L ${targetX - run},${targetY} L ${targetX},${targetY}`,
    sourceTip,
    targetTip,
  }
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
