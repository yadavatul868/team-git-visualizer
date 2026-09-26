import type { Graph, Lane } from '../types'
import { load, save } from './storage'

/** How lanes are stacked. The backend sends lanes in top-down family-tree order. */
export type LaneLayout = 'top-down' | 'centered'

/** One horizontal row of the graph: a single branch, or all folded (finished) branches. */
export type Row = { kind: 'lane'; lane: Lane } | { kind: 'finished'; lanes: Lane[] }

export interface Arrangement {
  rows: Row[]
  /** Lane id → row index. Folded lanes all map to the shared "finished" row. */
  rowOf: Map<number, number>
}

export function arrangeRows(graph: Graph, layout: LaneLayout, showFinished: boolean): Arrangement {
  const hidden = showFinished ? [] : graph.lanes.filter((lane) => lane.finished)
  const visible = graph.lanes.filter((lane) => showFinished || !lane.finished)
  const ordered = layout === 'centered' ? centered(visible) : visible

  const rows: Row[] = ordered.map((lane) => ({ kind: 'lane', lane }))
  if (hidden.length > 0) rows.push({ kind: 'finished', lanes: hidden })

  const rowOf = new Map<number, number>()
  rows.forEach((row, index) => {
    for (const lane of row.kind === 'lane' ? [row.lane] : row.lanes) rowOf.set(lane.id, index)
  })
  return { rows, rowOf }
}

/**
 * Experimental: the default branch in the middle, its branch families alternating above and
 * below it (most recent nearest). Families above are mirrored, so each branch stays next to the
 * branch it came from and sub-branches sit further out.
 */
function centered(lanes: Lane[]): Lane[] {
  const visibleIds = new Set(lanes.map((lane) => lane.id))
  const children = new Map<number, Lane[]>()
  const roots: Lane[] = []
  for (const lane of lanes) {
    if (lane.parent !== null && visibleIds.has(lane.parent)) {
      children.set(lane.parent, [...(children.get(lane.parent) ?? []), lane])
    } else {
      roots.push(lane)
    }
  }
  const family = (lane: Lane): Lane[] => [
    lane,
    ...(children.get(lane.id) ?? []).flatMap((child) => family(child)),
  ]

  const center = lanes.find((lane) => lane.kind === 'default') ?? roots[0]
  if (!center) return lanes
  const blocks = [
    ...(children.get(center.id) ?? []),
    ...roots.filter((root) => root.id !== center.id),
  ].map(family)

  const above: Lane[][] = []
  const below: Lane[][] = []
  blocks.forEach((block, index) => (index % 2 === 0 ? above : below).push(block))
  // Nearest-to-centre block first in `above`, so reverse the stacking and mirror each block.
  const top = [...above].reverse().flatMap((block) => [...block].reverse())
  return [...top, center, ...below.flat()]
}

export const savedLayout = (): LaneLayout =>
  load<LaneLayout>('tgv:layout', 'top-down') === 'centered' ? 'centered' : 'top-down'
export const saveLayout = (layout: LaneLayout) => save('tgv:layout', layout)
export const savedShowFinished = (): boolean => load<boolean>('tgv:show-finished', false) === true
export const saveShowFinished = (show: boolean) => save('tgv:show-finished', show)
