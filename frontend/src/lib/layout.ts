import type { Edge, Node } from '@xyflow/react'

import type { EdgeKind, Graph, GraphNode, Selection } from '../types'
import { authorColor, type AuthorSlots } from './colors'
import { initials } from './format'

/** Horizontal distance between consecutive commits. */
export const COLUMN_WIDTH = 120
/** Vertical distance between lanes. */
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
}

export interface GitEdgeData extends Record<string, unknown> {
  kind: EdgeKind
}

export type CommitFlowNode = Node<CommitNodeData, 'commit'>
export type GitFlowEdge = Edge<GitEdgeData, 'git'>

/** Centre of a commit in graph coordinates. */
export function commitCenter(commit: Pick<GraphNode, 'x' | 'lane'>): { x: number; y: number } {
  return { x: ORIGIN_X + commit.x * COLUMN_WIDTH, y: commit.lane * LANE_HEIGHT }
}

export function toFlowNodes(
  graph: Graph,
  slots: AuthorSlots,
  selection: Selection | null,
  highlightedAuthor: string | null,
): CommitFlowNode[] {
  return graph.nodes.map((commit) => {
    const center = commitCenter(commit)
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
