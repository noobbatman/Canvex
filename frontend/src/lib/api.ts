import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'

import { clearSession, loadSession, saveSession } from './storage'
import type {
  AIInteraction,
  AISolveResponse,
  AuditPageResult,
  AuthConfig,
  AuthSession,
  BranchDiff,
  ChannelDetail,
  ChannelListItem,
  Element,
  EventOperation,
  Invite,
  MemberRole,
  MergeStrategy,
  MergeSummary,
  PageAnalytics,
  PageSummary,
  ReplayEvent,
  SessionSummary,
  User,
} from '../types'

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
})

apiClient.interceptors.request.use((config) => {
  const session = loadSession()
  if (session?.accessToken) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${session.accessToken}`
  }
  return config
})

// Access tokens expire after 15 minutes; exchange the stored (rotating)
// refresh token for a new pair on the first 401 and retry the request once.
// A single in-flight refresh is shared so parallel 401s don't each burn a
// one-time-use refresh token (reuse trips the server's theft detection and
// revokes the whole family).
let refreshPromise: Promise<string | null> | null = null

const AUTH_PATHS_WITHOUT_REFRESH = ['/auth/token', '/auth/register', '/auth/refresh', '/auth/logout']

const refreshAccessToken = async (): Promise<string | null> => {
  const session = loadSession()
  if (!session?.refreshToken) return null
  try {
    // Plain axios, not apiClient: a 401 here must not recurse into another refresh.
    const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, {
      refresh_token: session.refreshToken,
    })
    saveSession({ ...session, accessToken: data.access_token, refreshToken: data.refresh_token })
    return data.access_token as string
  } catch {
    clearSession()
    return null
  }
}

type RetriableRequestConfig = InternalAxiosRequestConfig & { _retried?: boolean }

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as RetriableRequestConfig | undefined
    const isAuthPath = AUTH_PATHS_WITHOUT_REFRESH.some((path) => original?.url?.startsWith(path))
    if (error.response?.status === 401 && original && !original._retried && !isAuthPath) {
      original._retried = true
      refreshPromise = refreshPromise ?? refreshAccessToken().finally(() => {
        refreshPromise = null
      })
      const accessToken = await refreshPromise
      if (accessToken) {
        // The request interceptor re-reads the saved session, which now holds
        // the fresh access token.
        return apiClient(original)
      }
    }
    return Promise.reject(error)
  },
)

export const login = async (email: string, password: string): Promise<AuthSession> => {
  const form = new URLSearchParams()
  form.set('username', email)
  form.set('password', password)
  const { data } = await apiClient.post('/auth/token', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const user = await getMe(data.access_token)
  const session = { accessToken: data.access_token, refreshToken: data.refresh_token, user }
  saveSession(session)
  return session
}

export const register = async (
  email: string,
  displayName: string,
  password: string,
): Promise<AuthSession> => {
  const { data } = await apiClient.post('/auth/register', {
    email,
    display_name: displayName,
    password,
  })
  const session = { accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user }
  saveSession(session)
  return session
}

// Public sign-in configuration — which social buttons to render and how to
// validate them. Never throws for the caller: on failure it returns a
// "disabled" config so the standard email/password form still works.
export const getAuthConfig = async (): Promise<AuthConfig> => {
  try {
    const { data } = await axios.get(`${API_BASE_URL}/auth/config`)
    return {
      google_enabled: Boolean(data.google_enabled),
      google_client_id: data.google_client_id ?? '',
      institutional_domains: data.institutional_domains ?? [],
    }
  } catch {
    return { google_enabled: false, google_client_id: '', institutional_domains: [] }
  }
}

// Exchange a Google ID token (credential from Google Identity Services) for a
// Canvex session.
export const googleLogin = async (credential: string): Promise<AuthSession> => {
  const { data } = await apiClient.post('/auth/google', { credential })
  const session = { accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user }
  saveSession(session)
  return session
}

// Register with an institutional email (server validates the domain).
export const institutionalRegister = async (
  email: string,
  displayName: string,
  password: string,
): Promise<AuthSession> => {
  const { data } = await apiClient.post('/auth/institutional/register', {
    email,
    display_name: displayName,
    password,
  })
  const session = { accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user }
  saveSession(session)
  return session
}

export const logout = async (refreshToken: string) => {
  try {
    await apiClient.post('/auth/logout', { refresh_token: refreshToken })
  } finally {
    clearSession()
  }
}

export const getMe = async (overrideToken?: string): Promise<User> => {
  const { data } = await apiClient.get('/auth/me', {
    headers: overrideToken ? { Authorization: `Bearer ${overrideToken}` } : undefined,
  })
  return data
}

export const listChannels = async (): Promise<ChannelListItem[]> => {
  const { data } = await apiClient.get('/channels')
  return data
}

export const getChannel = async (channelId: string): Promise<ChannelDetail> => {
  const { data } = await apiClient.get(`/channels/${channelId}`)
  return data
}

export const createChannel = async (payload: {
  name: string
  description?: string
  is_private?: boolean
}): Promise<ChannelListItem> => {
  const { data } = await apiClient.post('/channels', payload)
  return data
}

export const createPage = async (channelId: string, title: string): Promise<PageSummary> => {
  const { data } = await apiClient.post(`/channels/${channelId}/pages`, { title })
  return data
}

export const listElements = async (pageId: string): Promise<Element[]> => {
  const { data } = await apiClient.get(`/pages/${pageId}/elements`)
  return data
}

export const getPagePresence = async (
  pageId: string,
): Promise<{ count: number; user_ids: string[] }> => {
  const { data } = await apiClient.get(`/pages/${pageId}/presence`)
  return { count: data.count ?? 0, user_ids: data.user_ids ?? [] }
}

export const getPresenceCount = async (pageId: string): Promise<number> => {
  const { count } = await getPagePresence(pageId)
  return count
}

export const uploadImage = async (file: File): Promise<{ url: string }> => {
  const form = new FormData()
  form.append('file', file)
  const { data } = await apiClient.post('/uploads', form)
  return data
}

export const listPageAiLog = async (pageId: string): Promise<AIInteraction[]> => {
  const { data } = await apiClient.get(`/pages/${pageId}/ai-log`)
  return data
}

// Scan the whole page image and get an answer for every problem that needs one,
// each with a normalised position so the answer can be dropped next to it.
// Synchronous (no AI worker/queue).
export const solvePage = async (pageId: string, snapshotB64: string): Promise<AISolveResponse> => {
  const { data } = await apiClient.post(`/pages/${pageId}/solve`, { snapshot_b64: snapshotB64 })
  return data
}

export const submitAIFeedback = async (
  interactionId: string,
  payload: { is_correct: boolean; correction_text?: string | null },
) => {
  const { data } = await apiClient.post(`/ai/${interactionId}/feedback`, payload)
  return data
}

export const createShareLink = async (
  pageId: string,
  expiresInHours = 168,
): Promise<{ token: string; share_url: string; expires_at: string }> => {
  const { data } = await apiClient.post(`/pages/${pageId}/share`, { expires_in_hours: expiresInHours })
  return data
}

export type SharedPageResponse = {
  page: PageSummary & { channel_id: string; is_deleted: boolean }
  elements: Element[]
}

export const getSharedPage = async (token: string): Promise<SharedPageResponse> => {
  const { data } = await apiClient.get(`/view/${token}`)
  return data
}

// ── Members & invites (Phase 11.3) ──────────────────────────────

export const createInvite = async (
  channelId: string,
  roleOnJoin: MemberRole = 'editor',
): Promise<Invite> => {
  const { data } = await apiClient.post(`/channels/${channelId}/invites`, { role_on_join: roleOnJoin })
  return data
}

export const acceptInvite = async (code: string): Promise<ChannelListItem> => {
  const { data } = await apiClient.post(`/invites/${encodeURIComponent(code.trim())}/accept`)
  return data
}

export const updateMemberRole = async (channelId: string, userId: string, role: MemberRole) => {
  const { data } = await apiClient.put(`/channels/${channelId}/members/${userId}`, { role })
  return data
}

export const removeMember = async (channelId: string, userId: string) => {
  await apiClient.delete(`/channels/${channelId}/members/${userId}`)
}

// ── Audit log (Phase 11.4) ──────────────────────────────────────

export type AuditFilters = {
  element_id?: string
  actor_id?: string
  operation?: EventOperation
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export const listAudit = async (pageId: string, filters: AuditFilters = {}): Promise<AuditPageResult> => {
  const { data } = await apiClient.get(`/pages/${pageId}/audit`, { params: filters })
  return data
}

// ── Branching (Phase 11.5) ──────────────────────────────────────

export const branchPage = async (pageId: string, title?: string): Promise<PageSummary> => {
  const { data } = await apiClient.post(`/pages/${pageId}/branch`, { title: title || undefined })
  return data
}

export const getBranchDiff = async (pageId: string): Promise<BranchDiff> => {
  const { data } = await apiClient.get(`/pages/${pageId}/diff`)
  return data
}

export const mergeBranch = async (pageId: string, strategy: MergeStrategy): Promise<MergeSummary> => {
  const { data } = await apiClient.post(`/pages/${pageId}/merge`, { strategy })
  return data
}

// ── Session replay (Phase 11.6) ─────────────────────────────────

export const listSessions = async (pageId: string): Promise<SessionSummary[]> => {
  const { data } = await apiClient.get(`/pages/${pageId}/sessions`)
  return data
}

// The replay endpoint streams NDJSON with server-side pacing, which axios
// can't consume incrementally in the browser — use fetch + a reader.
export const streamReplay = async (
  sessionId: string,
  // 0 = no server pacing (instant dump for client-driven playback)
  speed: 0 | 1 | 2 | 4,
  onEvent: (event: ReplayEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const session = loadSession()
  const response = await fetch(`${API_BASE_URL}/sessions/${sessionId}/replay?speed=${speed}`, {
    headers: session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {},
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`Replay failed (${response.status})`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emitLine = (line: string) => {
    if (!line) return
    try {
      onEvent(JSON.parse(line) as ReplayEvent)
    } catch {
      // skip malformed lines
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      emitLine(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  // Flush a final line that arrived without a trailing newline.
  buffer += decoder.decode()
  emitLine(buffer.trim())
}

// ── Analytics (Phase 11 surface for the Phase 10 endpoint) ──────

export const getPageAnalytics = async (pageId: string): Promise<PageAnalytics> => {
  const { data } = await apiClient.get(`/pages/${pageId}/analytics`)
  return data
}

// ── Export (Phase 10.5 endpoints, surfaced in the UI) ───────────

export const downloadPageExport = async (pageId: string, format: 'png' | 'pdf', title: string) => {
  const { data } = await apiClient.get(`/pages/${pageId}/export`, {
    params: { format },
    responseType: 'blob',
  })
  const url = URL.createObjectURL(data as Blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${title.replace(/[^\w-]+/g, '_') || 'canvex-page'}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
