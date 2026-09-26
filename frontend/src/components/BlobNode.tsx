import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'

import { formatDateTime } from '../lib/format'
import type { BlobFlowNode } from '../lib/layout'

/** A collapsed run of consecutive commits by one person on one branch (see lib/compact.ts). */
export function BlobNode({ data }: NodeProps<BlobFlowNode>) {
  const { commits } = data.blob
  const first = commits[0]
  const last = commits[commits.length - 1]
  const classes = ['blob-node']
  if (data.selected) classes.push('is-selected')
  if (data.dimmed) classes.push('is-dimmed')
  if (data.folded) classes.push('is-folded')

  return (
    <div className={classes.join(' ')} style={{ '--node-color': data.color } as CSSProperties}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="blob-body" aria-label={`${commits.length} commits by ${first.author.name}`}>
        <span className="blob-initials">{data.initials}</span>
        <span className="blob-count">{commits.length}</span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="commit-label">
        <span>{commits.length} commits</span>
        <span>
          {formatDateTime(first.committed_at)} – {formatDateTime(last.committed_at)}
        </span>
      </div>
      <div className="commit-tooltip" role="tooltip">
        <strong>
          {commits.length} commits by {first.author.name}
        </strong>
        <span>
          {formatDateTime(first.committed_at)} – {formatDateTime(last.committed_at)}
        </span>
        <span className="muted">Click to open · zoom in to see each commit</span>
      </div>
    </div>
  )
}
