// Mirrors backend/app/models.py

export type LaneKind = 'default' | 'branch' | 'deleted' | 'unlabelled'
export type EdgeKind = 'continue' | 'branch-off' | 'merge'

export interface Health {
  status: string
  token_configured: boolean
}

export interface BranchInfo {
  name: string
  tip_sha: string
  last_commit_at: string
  last_author_name: string
}

/** A repository suggested in the search box (from repos.json). */
export interface RepoSuggestion {
  name: string
  url: string
}

export interface RepoSnapshot {
  repo: string
  url: string
  default_branch: string | null
  fetched_at: string | null
  branches: BranchInfo[]
}

/** One real person, however many git identities (name + email) they committed with. */
export interface PersonRef {
  key: string
  name: string
  login: string | null
}

export interface Identity {
  name: string
  email: string
  commit_count: number
}

export interface Person extends PersonRef {
  commit_count: number
  manually_linked: boolean
  identities: Identity[]
}

export interface CommitRef {
  sha: string
  short_sha: string
  author: PersonRef
  author_name: string
  author_email: string
  authored_at: string
  committed_at: string
  subject: string
}

export interface Lane {
  id: number
  name: string
  kind: LaneKind
  commit_count: number
  /** Lane this branch was branched off from (family tree), if shown nested. */
  parent: number | null
  /** Nesting level in the family tree (0 = top level). */
  depth: number
  /** Merged and done; can be folded into one row. */
  finished: boolean
}

export interface GraphNode {
  sha: string
  short_sha: string
  lane: number
  x: number
  author: PersonRef
  author_name: string
  author_email: string
  authored_at: string
  committed_at: string
  subject: string
  is_merge: boolean
  refs: string[]
  hidden_parent_count: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  parent_index: number
}

export interface AuthorStat extends PersonRef {
  commit_count: number
}

export interface Graph {
  repo: string
  default_branch: string | null
  fetched_at: string | null
  days: number | null
  truncated: boolean
  lanes: Lane[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  authors: AuthorStat[]
  summary: {
    commit_count: number
    merge_count: number
    branch_count: number
    lane_count: number
  }
}

export interface FileChange {
  path: string
  old_path: string | null
  status: string
  additions: number | null
  deletions: number | null
}

export interface CommitDetails {
  sha: string
  short_sha: string
  author: PersonRef
  author_name: string
  author_email: string
  authored_at: string
  committer_name: string
  committer_email: string
  committed_at: string
  message: string
  parents: CommitRef[]
  branches: string[]
  is_merge: boolean
  merged_branch: string | null
  pr_number: number | null
  files: FileChange[]
  files_truncated: boolean
  url: string
}

export interface EdgeDetails {
  source: CommitRef
  target: CommitRef
  parent_index: number
  is_merge: boolean
  time_gap_seconds: number
  merged_by: PersonRef | null
  merged_branch: string | null
  pr_number: number | null
  commits_brought_in: number | null
  brought_in: CommitRef[]
  files: FileChange[]
  files_truncated: boolean
  url: string
}

export type Selection =
  | { type: 'node'; sha: string }
  | { type: 'edge'; id: string; source: string; target: string }
  | { type: 'blob'; id: string; shas: string[] }
