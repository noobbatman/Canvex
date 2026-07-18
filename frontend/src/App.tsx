import { useCallback, useEffect, useMemo, useState } from 'react'

import AuthPanel from './components/AuthPanel'
import CanvasBoard from './components/CanvasBoard'
import Sidebar from './components/Sidebar'
import SharedPageViewer from './components/SharedPageViewer'
import { createChannel, createPage, getChannel, getMe, listChannels, logout } from './lib/api'
import { clearSession, loadSession } from './lib/storage'
import type { AuthSession, ChannelDetail, ChannelListItem, PageSummary } from './types'

const SHARE_VIEW_PATH_PATTERN = /^\/view\/([^/]+)$/

const App = () => {
  const shareToken = useMemo(() => {
    const match = window.location.pathname.match(SHARE_VIEW_PATH_PATTERN)
    return match ? decodeURIComponent(match[1]) : null
  }, [])

  if (shareToken) {
    return <SharedPageViewer token={shareToken} />
  }

  return <AuthenticatedApp />
}

const AuthenticatedApp = () => {
  const [session, setSession] = useState<AuthSession | null>(loadSession())
  const [channels, setChannels] = useState<ChannelListItem[]>([])
  const [selectedChannel, setSelectedChannel] = useState<ChannelDetail | null>(null)
  const [selectedPage, setSelectedPage] = useState<PageSummary | null>(null)
  const [isBooting, setIsBooting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const accessToken = session?.accessToken

  const handleSelectChannel = useCallback(async (channelId: string) => {
    const detail = await getChannel(channelId)
    setSelectedChannel(detail)
    if (detail.pages.length) {
      setSelectedPage(detail.pages[0])
    } else {
      setSelectedPage(null)
    }
  }, [])

  const refreshChannels = useCallback(async () => {
    const data = await listChannels()
    setChannels(data)
    if (data.length) {
      await handleSelectChannel(data[0].id)
    } else {
      setSelectedChannel(null)
      setSelectedPage(null)
    }
  }, [handleSelectChannel])

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      if (!accessToken) {
        setChannels([])
        setSelectedChannel(null)
        setSelectedPage(null)
        setIsBooting(false)
        return
      }
      try {
        await getMe()
        if (cancelled) return
        await refreshChannels()
      } catch {
        if (cancelled) return
        clearSession()
        setSession(null)
        setChannels([])
        setSelectedChannel(null)
        setSelectedPage(null)
      } finally {
        if (!cancelled) {
          setIsBooting(false)
        }
      }
    }

    boot()
    return () => {
      cancelled = true
    }
  }, [accessToken, refreshChannels])

  const handleCreateChannel = async (payload: { name: string; description?: string }) => {
    try {
      const channel = await createChannel(payload)
      setChannels((prev) => [channel, ...prev])
      await handleSelectChannel(channel.id)
    } catch {
      setError('Unable to create channel.')
    }
  }

  const handleCreatePage = async (title: string) => {
    if (!selectedChannel) return
    try {
      const page = await createPage(selectedChannel.id, title)
      const updated = await getChannel(selectedChannel.id)
      setSelectedChannel(updated)
      setSelectedPage(page)
    } catch {
      setError('Unable to create page.')
    }
  }

  const handleLogout = async () => {
    if (!session) return
    try {
      await logout(session.refreshToken)
    } finally {
      setSession(null)
      setChannels([])
      setSelectedChannel(null)
      setSelectedPage(null)
    }
  }

  const pageList = useMemo(() => selectedChannel?.pages ?? [], [selectedChannel])

  if (isBooting) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Booting Canvex…
      </div>
    )
  }

  if (!session) {
    return <AuthPanel onAuthenticated={(next) => setSession(next)} />
  }

  return (
    <div className="workspace-shell flex h-screen overflow-hidden text-slate-950">
      <Sidebar
        user={session.user}
        channels={channels}
        selectedChannel={selectedChannel}
        selectedPage={selectedPage}
        onSelectChannel={handleSelectChannel}
        onCreateChannel={handleCreateChannel}
        onSelectPage={(pageId) => {
          const page = pageList.find((item) => item.id === pageId) ?? null
          setSelectedPage(page)
        }}
        onCreatePage={handleCreatePage}
      />
      <main className="workspace-main relative flex flex-1 flex-col">
        <header className="workspace-context-bar">
          <div className="workspace-channel-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Channel
            </p>
            <h2 className="font-reading-serif text-xl text-slate-950">
              {selectedChannel?.name ?? 'No channel selected'}
            </h2>
          </div>
          <div className="workspace-header-actions">
            {error && <span className="text-sm font-medium text-rose-600">{error}</span>}
            <button
              type="button"
              onClick={handleLogout}
              className="workspace-ghost-button"
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="flex-1">
          <CanvasBoard page={selectedPage} user={session.user} accessToken={session.accessToken} />
        </div>
      </main>
    </div>
  )
}

export default App
