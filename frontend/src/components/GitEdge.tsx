import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

import { gitEdgePath, jumpStubPaths, type GitFlowEdge } from '../lib/layout'

/** Longest branch name shown on a jump label before it's shortened (full name in the tooltip). */
const MAX_LABEL_CHARS = 12

const shorten = (name: string) =>
  name.length > MAX_LABEL_CHARS ? `${name.slice(0, MAX_LABEL_CHARS - 1)}…` : name

export function GitEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<GitFlowEdge>) {
  const kind = data?.kind ?? 'continue'
  if (!data?.jump) {
    const path = gitEdgePath(kind, sourceX, sourceY, targetX, targetY)
    return <BaseEdge id={id} path={path} interactionWidth={18} />
  }

  // Rows aren't adjacent: short labelled stubs at both ends instead of a line across other rows.
  const { targetAbove, targetBranch, sourceBranch, sourceSlot, targetSlot } = data.jump
  const stubs = jumpStubPaths(sourceX, sourceY, targetX, targetY, targetAbove, sourceSlot, targetSlot)
  const verb = kind === 'merge' ? 'merges into' : kind === 'branch-off' ? 'starts' : 'continues on'
  const select = (event: React.MouseEvent) => {
    event.stopPropagation()
    data.onSelect?.()
  }
  return (
    <>
      <BaseEdge id={`${id}-out`} path={stubs.source} interactionWidth={16} />
      <BaseEdge id={`${id}-in`} path={stubs.target} interactionWidth={16} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`jump-label nodrag nopan${data.selected ? ' is-selected' : ''}`}
          style={{
            transform: `translate(0, -50%) translate(${stubs.sourceTip[0] + 2}px, ${stubs.sourceTip[1]}px)`,
          }}
          onClick={select}
          title={`${sourceBranch} ${verb} ${targetBranch} (${targetAbove ? 'above' : 'below'}) · click for details`}
        >
          → {shorten(targetBranch)} <span aria-hidden>{targetAbove ? '↑' : '↓'}</span>
        </button>
        <button
          type="button"
          className={`jump-label nodrag nopan${data.selected ? ' is-selected' : ''}`}
          style={{
            transform: `translate(-100%, -50%) translate(${stubs.targetTip[0] - 2}px, ${stubs.targetTip[1]}px)`,
          }}
          onClick={select}
          title={`${sourceBranch} ${verb} ${targetBranch} (from ${targetAbove ? 'below' : 'above'}) · click for details`}
        >
          <span aria-hidden>{targetAbove ? '↓' : '↑'}</span> {shorten(sourceBranch)} →
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
