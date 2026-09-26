import { describe, expect, it } from 'vitest'

import type { Graph, Lane } from '../types'
import { arrangeRows, withoutDeleted } from './rows'

const lane = (id: number, name: string, kind: Lane['kind'], extra: Partial<Lane> = {}): Lane => ({
  id,
  name,
  kind,
  commit_count: 1,
  parent: id === 0 ? null : 0,
  depth: id === 0 ? 0 : 1,
  finished: false,
  long_lived: kind === 'default',
  last_commit_at: null,
  ...extra,
})

const node = (sha: string, laneId: number) => ({ sha, lane: laneId }) as Graph['nodes'][number]

const graph = {
  lanes: [
    lane(0, 'main', 'default'),
    lane(1, 'feat/live', 'branch'),
    lane(2, 'feat-old', 'deleted', { finished: true }),
    lane(3, '(unnamed branch)', 'unlabelled', { finished: true }),
    lane(4, 'feat/merged', 'branch', { finished: true }),
  ],
  nodes: [node('m1', 0), node('l1', 1), node('d1', 2), node('u1', 3), node('f1', 4), node('m2', 0)],
  edges: [
    { id: 'm1-l1', source: 'm1', target: 'l1', kind: 'branch-off', parent_index: 0 },
    { id: 'm1-d1', source: 'm1', target: 'd1', kind: 'branch-off', parent_index: 0 },
    { id: 'd1-m2', source: 'd1', target: 'm2', kind: 'merge', parent_index: 1 },
    { id: 'm1-m2', source: 'm1', target: 'm2', kind: 'continue', parent_index: 0 },
  ],
} as unknown as Graph

const laneNames = (rows: ReturnType<typeof arrangeRows>['rows']) =>
  rows.map((row) => (row.kind === 'lane' ? row.lane.name : `folded:${row.lanes.map((l) => l.name).join(',')}`))

describe('deleted branches', () => {
  it('drops their commits and lines but keeps lane ids for lookups', () => {
    const shown = withoutDeleted(graph)
    expect(shown.nodes.map((n) => n.sha)).toEqual(['m1', 'l1', 'f1', 'm2'])
    expect(shown.edges.map((e) => e.id)).toEqual(['m1-l1', 'm1-m2'])
    expect(shown.lanes).toHaveLength(5)
  })

  it('leaves them out of the rows (even the folded merged row) unless shown', () => {
    expect(laneNames(arrangeRows(graph, 'top-down', false, false).rows)).toEqual([
      'folded:feat/merged',
      'main',
      'feat/live',
    ])
    expect(laneNames(arrangeRows(graph, 'top-down', false, true).rows)).toEqual([
      'folded:feat-old,(unnamed branch),feat/merged',
      'main',
      'feat/live',
    ])
    expect(laneNames(arrangeRows(graph, 'top-down', true, false).rows)).toEqual([
      'main',
      'feat/live',
      'feat/merged',
    ])
  })
})

describe('centered layout with a spine', () => {
  const spine = {
    lanes: [
      lane(0, 'main', 'default'),
      lane(1, 'stage', 'branch', { long_lived: true, parent: null, depth: 0 }),
      lane(2, 'dev', 'branch', { long_lived: true, parent: null, depth: 0 }),
      lane(3, 'hotfix', 'branch', { parent: 0 }),
      lane(4, 'feat/a', 'branch', { parent: 2 }),
      lane(5, 'feat/b', 'branch', { parent: 2 }),
      lane(6, 'feat/a-sub', 'branch', { parent: 4, depth: 2 }),
    ],
    nodes: [],
    edges: [],
  } as unknown as Graph

  it("keeps main, stage, dev together with each one's families on the outside", () => {
    const result = arrangeRows(spine, 'centered', true, true)
    expect(laneNames(result.rows)).toEqual([
      'hotfix', // main's family, above
      'main',
      'stage',
      'dev',
      'feat/a', // dev's families below, nearest first
      'feat/a-sub',
      'feat/b',
    ])
    expect(result.anchorRow).toBe(1) // centred on main
  })

  it('still alternates around the default branch when it is the only long-lived one', () => {
    const trunk = {
      ...spine,
      lanes: [lane(0, 'main', 'default'), lane(1, 'a', 'branch'), lane(2, 'b', 'branch')],
    } as unknown as Graph
    expect(laneNames(arrangeRows(trunk, 'centered', true, true).rows)).toEqual(['a', 'main', 'b'])
  })
})
