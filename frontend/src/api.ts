import type { CommitDetails, EdgeDetails, Graph, Health, Person, RepoSnapshot } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (typeof body.detail === 'string') detail = body.detail
      else if (Array.isArray(body.detail)) detail = body.detail.map((d: { msg: string }) => d.msg).join('; ')
    } catch {
      // Not JSON (e.g. the backend isn't running); keep the status text.
    }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

export const api = {
  health: () => request<Health>('/api/health'),

  sync: (url: string) =>
    request<RepoSnapshot>('/api/repo/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  graph: (repo: string, days: number, priority: string[], signal?: AbortSignal) =>
    request<Graph>(
      `/api/graph?${new URLSearchParams({ repo, days: String(days), priority: priority.join(',') })}`,
      { signal },
    ),

  commit: (repo: string, sha: string, signal?: AbortSignal) =>
    request<CommitDetails>(`/api/commit/${sha}?${new URLSearchParams({ repo })}`, { signal }),

  edge: (repo: string, source: string, target: string, signal?: AbortSignal) =>
    request<EdgeDetails>(`/api/edge?${new URLSearchParams({ repo, source, target })}`, { signal }),

  people: (repo: string, signal?: AbortSignal) =>
    request<Person[]>(`/api/people?${new URLSearchParams({ repo })}`, { signal }),

  linkPeople: (repo: string, email: string, targetEmail: string) =>
    request<Person[]>('/api/people/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, email, target_email: targetEmail }),
    }),

  unlinkPerson: (repo: string, key: string) =>
    request<Person[]>('/api/people/unlink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, key }),
    }),
}
