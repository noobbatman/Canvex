import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'

import { clearSession, loadSession, saveSession } from './storage'
import type { AIInteraction, AuthSession, ChannelDetail, ChannelListItem, Element, PageSummary, User } from '../types'

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

export const getPresenceCount = async (pageId: string): Promise<number> => {
  const { data } = await apiClient.get(`/pages/${pageId}/presence`)
  return data.count ?? 0
}

export const listPageAiLog = async (pageId: string): Promise<AIInteraction[]> => {
  const { data } = await apiClient.get(`/pages/${pageId}/ai-log`)
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
