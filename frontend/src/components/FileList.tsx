import type { FileChange } from '../types'

const STATUS_LABEL: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
}

export function FileList({ files, truncated }: { files: FileChange[]; truncated: boolean }) {
  if (files.length === 0) return <p className="muted">No file changes.</p>
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)

  return (
    <div className="file-list">
      <div className="file-totals">
        {files.length}
        {truncated ? '+' : ''} file{files.length === 1 ? '' : 's'}
        <span className="additions">+{additions}</span>
        <span className="deletions">−{deletions}</span>
      </div>
      <ul>
        {files.map((file) => (
          <li key={`${file.old_path ?? ''}→${file.path}`}>
            <span
              className={`status-badge status-${file.status}`}
              title={STATUS_LABEL[file.status] ?? file.status}
            >
              {file.status}
            </span>
            <span className="file-path mono" title={file.path}>
              {file.old_path ? (
                <>
                  <span className="muted">{file.old_path} → </span>
                  {file.path}
                </>
              ) : (
                file.path
              )}
            </span>
            {file.additions === null ? (
              <span className="muted file-counts">binary</span>
            ) : (
              <span className="file-counts">
                <span className="additions">+{file.additions}</span>
                <span className="deletions">−{file.deletions}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {truncated && <p className="muted">Only the first {files.length} files are listed.</p>}
    </div>
  )
}
