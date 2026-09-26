import { describe, expect, it } from 'vitest'

import type { Graph, GraphEdge, GraphNode } from '../types'
import { LEVELS, compact, levelForZoom, zoomToExpand } from './compact'

/** Build a graph from "sha:lane:author" commits (oldest first) and "a>b:kind" edges. */
function graph(commits: string[], edges: string[], tips: string[] = []): Graph {
  const nodes: GraphNode[] = commits.map((spec, x) => {
    const [sha, lane, author] = spec.split(':')
    return {
      sha,
      short_sha: sha,
      lane: Number(lane),
      x,
      author: { key: author, name: author, login: null },
      author_name: author,
      author_email: `${author}@x`,
      authored_at: `2026-09-${String(10 + x).padStart(2, '0')}T10:00:00Z`,
      committed_at: `2026-09-${String(10 + x).padStart(2, '0')}T10:00:00Z`,
      subject: sha,
      is_merge: false,
      refs: tips.includes(sha) ? ['tip'] : [],
      hidden_parent_count: 0,
    }
  })
  const graphEdges: GraphEdge[] = edges.map((spec) => {
    const [pair, kind] = spec.split(':')
    const [source, target] = pair.split('>')
    return { id: `${source}-${target}`, source, target, kind: kind as GraphEdge['kind'], parent_index: kind === 'merge' ? 1 : 0 }
  })
  for (const edge of graphEdges) {
    if (edge.kind === 'merge') nodes.find((n) => n.sha === edge.target)!.is_merge = true
  }
  return { nodes, edges: graphEdges } as unknown as Graph
}

const chain = (shas: string[]) =>
  shas.slice(1).map((sha, i) => `${shas[i]}>${sha}:continue`)

const shape = (result: ReturnType<typeof compact>) =>
  result.units.map((unit) =>
    unit.kind === 'blob' ? `[${unit.blob.commits.map((c) => c.sha).join(' ')}]` : unit.commit.sha,
  )

describe('compact', () => {
  const straight = graph(
    ['m0:0:ann', 'm1:0:ann', 'm2:0:ann', 'm3:0:ann', 'm4:0:ann', 'm5:0:ann'],
    chain(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']),
    ['m5'],
  )

  it('collapses a straight stretch but keeps its ends', () => {
    expect(shape(compact(straight, 2, new Set()))).toEqual(['m0', '[m1 m2 m3 m4]', 'm5'])
  })

  it('shows every commit at the most detailed level', () => {
    expect(compact(straight, Infinity, new Set()).units).toHaveLength(6)
  })

  it('only collapses runs at least as long as the level asks for', () => {
    expect(shape(compact(straight, 5, new Set()))).toHaveLength(6)
    expect(shape(compact(straight, 4, new Set()))).toEqual(['m0', '[m1 m2 m3 m4]', 'm5'])
  })

  it('splits runs by author', () => {
    const mixed = graph(
      ['m0:0:ann', 'm1:0:ann', 'm2:0:ann', 'm3:0:bob', 'm4:0:bob', 'm5:0:ann'],
      chain(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']),
      ['m5'],
    )
    expect(shape(compact(mixed, 2, new Set()))).toEqual(['m0', '[m1 m2]', '[m3 m4]', 'm5'])
  })

  it('never hides a commit where a branch starts or merges', () => {
    // dev branches off at m2 and merges back into m5
    const branched = graph(
      ['m0:0:ann', 'm1:0:ann', 'm2:0:ann', 'd0:1:bob', 'm3:0:ann', 'm4:0:ann', 'd1:1:bob', 'm5:0:ann', 'm6:0:ann'],
      [...chain(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']), 'm2>d0:branch-off', 'd0>d1:continue', 'd1>m5:merge'],
      ['m6'],
    )
    const result = compact(branched, 2, new Set())
    const visible = result.units.filter((u) => u.kind === 'commit').map((u) => (u.kind === 'commit' ? u.commit.sha : ''))
    expect(visible).toEqual(expect.arrayContaining(['m2', 'd0', 'd1', 'm5']))
    expect(shape(result)).toEqual(['m0', 'm1', 'm2', 'd0', '[m3 m4]', 'd1', 'm5', 'm6'])
  })

  it('keeps selected commits out of blobs', () => {
    expect(shape(compact(straight, 2, new Set(['m2'])))).toEqual(['m0', 'm1', 'm2', '[m3 m4]', 'm5'])
  })

  it('keeps every parent to the left of its child', () => {
    // two interleaved branches with long straight stretches
    const commits: string[] = ['r:0:ann']
    const edges: string[] = []
    let main = 'r'
    let side = ''
    for (let i = 0; i < 20; i++) {
      commits.push(`a${i}:0:ann`)
      edges.push(`${main}>a${i}:continue`)
      main = `a${i}`
      if (i === 3) {
        commits.push(`b0:1:bob`)
        edges.push(`a3>b0:branch-off`)
        side = 'b0'
      } else if (i > 3 && i < 15) {
        commits.push(`b${i}:1:bob`)
        edges.push(`${side}>b${i}:continue`)
        side = `b${i}`
      }
    }
    const g = graph(commits, edges, [main, side])
    for (const level of LEVELS) {
      const result = compact(g, level.minRun, new Set())
      for (const edge of g.edges) {
        const from = result.columnOf.get(edge.source)!
        const to = result.columnOf.get(edge.target)!
        if (result.unitIdOf.get(edge.source) !== result.unitIdOf.get(edge.target)) {
          expect(from).toBeLessThan(to)
        }
      }
    }
    expect(compact(g, 2, new Set()).units.length).toBeLessThan(g.nodes.length / 3)
  })
})

describe('zoom levels', () => {
  it('maps zoom to levels, most detailed first', () => {
    expect(levelForZoom(1)).toBe(0)
    expect(levelForZoom(0.45)).toBe(1)
    expect(levelForZoom(0.3)).toBe(2)
    expect(levelForZoom(0.1)).toBe(3)
  })

  it('does not flip back and forth right at a boundary', () => {
    expect(levelForZoom(0.53, 0)).toBe(0) // just below 0.55, still level 0
    expect(levelForZoom(0.5, 0)).toBe(1) // clearly past it
    expect(levelForZoom(0.57, 1)).toBe(1) // just above, still level 1
  })

  it('zooms in just far enough to open a blob, no further', () => {
    // A blob of 5 opens at the level that only collapses runs of 8+, not at full detail.
    expect(LEVELS[levelForZoom(zoomToExpand(5))].minRun).toBe(8)
    expect(LEVELS[levelForZoom(zoomToExpand(3))].minRun).toBe(4)
    expect(LEVELS[levelForZoom(zoomToExpand(12))].minRun).toBe(Infinity)
  })
})
