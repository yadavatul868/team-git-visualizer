import { BaseEdge, type EdgeProps } from '@xyflow/react'

import { gitEdgePath, type GitFlowEdge } from '../lib/layout'

export function GitEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<GitFlowEdge>) {
  const path = gitEdgePath(data?.kind ?? 'continue', sourceX, sourceY, targetX, targetY)
  return <BaseEdge id={id} path={path} interactionWidth={18} />
}
