import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'

import { formatDateTime } from '../lib/format'
import type { CommitFlowNode } from '../lib/layout'

export function CommitNode({ data }: NodeProps<CommitFlowNode>) {
  const { commit } = data
  const classes = ['commit-node']
  if (commit.is_merge) classes.push('is-merge')
  if (data.selected) classes.push('is-selected')
  if (data.dimmed) classes.push('is-dimmed')
  if (data.folded) classes.push('is-folded')

  return (
    <div className={classes.join(' ')} style={{ '--node-color': data.color } as CSSProperties}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="commit-dot" aria-label={`Commit ${commit.short_sha} by ${commit.author.name}`}>
        {data.initials}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />

      {commit.refs.length > 0 && (
        <div className="commit-refs">
          {commit.refs.map((ref) => (
            <span key={ref} className="ref-pill" title={`Tip of ${ref}`}>
              {ref}
            </span>
          ))}
        </div>
      )}
      <div className="commit-label">
        <span className="mono">{commit.short_sha}</span>
        <span>{formatDateTime(commit.committed_at)}</span>
      </div>
      <div className="commit-tooltip" role="tooltip">
        <strong>{commit.subject}</strong>
        <span>
          {commit.author.name} · {formatDateTime(commit.authored_at)}
        </span>
        {commit.hidden_parent_count > 0 && (
          <span className="muted">Parent commit is older than the time window</span>
        )}
      </div>
    </div>
  )
}
