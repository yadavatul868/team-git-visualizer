import type { Graph, GraphNode } from '../types'

/**
 * Horizontal compaction ("semantic zoom"): when zoomed out, straight stretches of commits on one
 * branch collapse into a single blob, and the time axis shrinks with them.
 *
 * Only commits that don't shape the graph may collapse. A commit stays visible (an "anchor") if it:
 * - starts or ends a branch, or has a branch-off or merge line in or out
 * - is a merge commit or a branch tip
 * - has a parent outside the time window
 * - is selected
 * Everything else sits on a straight line with exactly one line in and one out on its own row, so
 * replacing a run of them with one blob keeps every junction exactly where it was. Runs are split
 * by author, so colours still show who did what.
 */

export interface Blob {
  id: string
  lane: number
  authorKey: string
  commits: GraphNode[]
}

export type Unit = { kind: 'commit'; commit: GraphNode } | { kind: 'blob'; blob: Blob }

export interface Compaction {
  /** Shortest run that collapses at this level (Infinity = every commit shown). */
  minRun: number
  /** Columns, left to right. */
  units: Unit[]
  /** Commit sha → column. Collapsed commits map to their blob's column. */
  columnOf: Map<string, number>
  /** Commit sha → flow node id (its own sha, or the blob that contains it). */
  unitIdOf: Map<string, string>
}

/** Zoom levels, most detailed first. Further out, shorter runs collapse too. */
export const LEVELS = [
  { minZoom: 0.55, minRun: Infinity },
  { minZoom: 0.4, minRun: 8 },
  { minZoom: 0.26, minRun: 4 },
  { minZoom: 0, minRun: 2 },
] as const

/** Zoom must pass a level boundary by this much before the level changes (avoids flicker). */
const HYSTERESIS = 0.03

/** Index into LEVELS for a zoom, sticking with `current` while near its boundaries. */
export function levelForZoom(zoom: number, current?: number): number {
  const plain = LEVELS.findIndex((level) => zoom >= level.minZoom)
  if (current === undefined || plain === current) return plain
  const lower = LEVELS[current].minZoom - HYSTERESIS
  const upper = current > 0 ? LEVELS[current - 1].minZoom + HYSTERESIS : Infinity
  return zoom >= lower && zoom < upper ? current : plain
}

/** The zoom at which a blob of `size` commits opens up: the most zoomed-out level that shows
 *  its commits individually, so clicking a blob zooms in only as far as needed. */
export function zoomToExpand(size: number): number {
  const level = [...LEVELS].reverse().find((candidate) => candidate.minRun > size) ?? LEVELS[0]
  return level.minZoom + HYSTERESIS * 2
}

export function compact(graph: Graph, minRun: number, keep: ReadonlySet<string>): Compaction {
  const continueChild = new Map<string, string>()
  const continueParent = new Map<string, string>()
  const anchors = new Set<string>(keep)
  for (const edge of graph.edges) {
    if (edge.kind === 'continue') {
      continueChild.set(edge.source, edge.target)
      continueParent.set(edge.target, edge.source)
    } else {
      anchors.add(edge.source)
      anchors.add(edge.target)
    }
  }
  const bySha = new Map(graph.nodes.map((node) => [node.sha, node]))
  for (const node of graph.nodes) {
    if (
      node.is_merge ||
      node.refs.length > 0 ||
      node.hidden_parent_count > 0 ||
      !continueParent.has(node.sha) ||
      !continueChild.has(node.sha)
    ) {
      anchors.add(node.sha)
    }
  }

  const blobOf = new Map<string, Blob>()
  if (Number.isFinite(minRun)) {
    const seen = new Set<string>()
    for (const node of graph.nodes) {
      if (anchors.has(node.sha) || seen.has(node.sha)) continue
      const run: GraphNode[] = []
      let current: GraphNode | undefined = node
      while (current && !anchors.has(current.sha) && current.author.key === node.author.key) {
        run.push(current)
        seen.add(current.sha)
        const next = continueChild.get(current.sha)
        current = next ? bySha.get(next) : undefined
      }
      if (run.length >= minRun) {
        const blob = { id: `blob:${run[0].sha}`, lane: node.lane, authorKey: node.author.key, commits: run }
        for (const commit of run) blobOf.set(commit.sha, blob)
      }
    }
  }

  // Columns in original order (nodes arrive oldest → newest); a blob takes its first commit's slot.
  // Collapsed commits only connect to their neighbours in the run, so this keeps parents left of
  // their children.
  const units: Unit[] = []
  const columnOf = new Map<string, number>()
  const unitIdOf = new Map<string, string>()
  for (const node of graph.nodes) {
    const blob = blobOf.get(node.sha)
    if (!blob) {
      units.push({ kind: 'commit', commit: node })
      columnOf.set(node.sha, units.length - 1)
      unitIdOf.set(node.sha, node.sha)
    } else if (blob.commits[0] === node) {
      units.push({ kind: 'blob', blob })
      for (const commit of blob.commits) {
        columnOf.set(commit.sha, units.length - 1)
        unitIdOf.set(commit.sha, blob.id)
      }
    }
  }
  return { minRun, units, columnOf, unitIdOf }
}
