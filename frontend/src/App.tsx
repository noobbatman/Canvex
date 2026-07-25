import { BarChart3, FileDown, FileType, GitCompare, History, LogOut, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import AnalyticsModal from './components/AnalyticsModal'
import AuditPanel from './components/AuditPanel'
import AuthPanel from './components/AuthPanel'
import BranchDiffModal from './components/BranchDiffModal'
import CanvasBoard from './components/CanvasBoard'
import ReplayModal from './components/ReplayModal'
import SharedPageViewer from './components/SharedPageViewer'
import Sidebar from './components/Sidebar'
import {
  branchPage,
  createChannel,
  createPage,
  downloadPageExport,
  getChannel,
  getMe,
  getPagePresence,
  listChannels,
  logout,
} from './lib/api'
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
  const [showAudit, setShowAudit] = useState(false)
  const [showReplay, setShowReplay] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [highlight, setHighlight] = useState<{ id: string; nonce: number } | null>(null)
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([])
  // Tracked separately from selectedPage: merging soft-deletes the branch and
  // the follow-up refresh moves selection to the parent — the modal must stay
  // up to show the merge summary until the user closes it.
  const [diffBranch, setDiffBranch] = useState<PageSummary | null>(null)
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

  // Re-fetch the open channel without losing the currently selected page.
  const refreshChannelDetail = useCallback(async () => {
    if (!selectedChannel) return
    const detail = await getChannel(selectedChannel.id)
    setSelectedChannel(detail)
    setSelectedPage((current) => {
      if (!current) return detail.pages[0] ?? null
      return detail.pages.find((page) => page.id === current.id) ?? detail.pages[0] ?? null
    })
  }, [selectedChannel])

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

  const refreshChannelList = useCallback(async () => {
    const data = await listChannels()
    setChannels(data)
  }, [])

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

  // Close page-scoped panels when the page changes (the diff modal is exempt:
  // it survives the post-merge selection jump to the parent page).
  useEffect(() => {
    setShowAudit(false)
    setShowReplay(false)
    setShowAnalytics(false)
    setHighlight(null)
  }, [selectedPage?.id])

  // Poll page presence for the members' "online now" dots.
  useEffect(() => {
    const pageId = selectedPage?.id
    if (!pageId) {
      setOnlineUserIds([])
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const { user_ids } = await getPagePresence(pageId)
        if (!cancelled) setOnlineUserIds(user_ids)
      } catch {
        if (!cancelled) setOnlineUserIds([])
      }
    }
    poll()
    const timer = window.setInterval(poll, 10000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedPage?.id])

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

  const handleCreateBranch = async (pageId: string) => {
    if (!selectedChannel) return
    try {
      const branch = await branchPage(pageId)
      const updated = await getChannel(selectedChannel.id)
      setSelectedChannel(updated)
      setSelectedPage(updated.pages.find((page) => page.id === branch.id) ?? branch)
    } catch {
      setError('Unable to create branch.')
    }
  }

  const handleExport = async (format: 'png' | 'pdf') => {
    if (!selectedPage) return
    try {
      await downloadPageExport(selectedPage.id, format, selectedPage.title)
    } catch {
      setError(`Unable to export ${format.toUpperCase()}.`)
    }
  }

  const handleLogout = async () => {
    if (!session) return
    try {
      // The refresh interceptor rotates the token in storage, so React state can
      // hold a stale one — revoke the freshest token, not the one we rendered with.
      const refreshToken = loadSession()?.refreshToken ?? session.refreshToken
      await logout(refreshToken)
    } finally {
      setSession(null)
      setChannels([])
      setSelectedChannel(null)
      setSelectedPage(null)
    }
  }

  const pageList = useMemo(() => selectedChannel?.pages ?? [], [selectedChannel])

  const diffParentTitle = useMemo(() => {
    if (!diffBranch?.branch_of) return 'parent page'
    return pageList.find((page) => page.id === diffBranch.branch_of)?.title ?? 'parent page'
  }, [diffBranch, pageList])

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
        onCreateBranch={handleCreateBranch}
        onChannelChanged={refreshChannelDetail}
        onChannelsChanged={refreshChannelList}
        onlineUserIds={onlineUserIds}
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
            {error && <p className="mt-1 text-sm font-medium text-rose-600">{error}</p>}
          </div>
        </header>
        <div className="workspace-action-rail">
          {selectedPage && (
            <>
              <button
                type="button"
                title="Audit log"
                onClick={() => setShowAudit((prev) => !prev)}
                className={`workspace-rail-button ${showAudit ? 'bg-[#dde9ff] text-indigo-700' : ''}`}
              >
                <ScrollText size={16} />
              </button>
              <button
                type="button"
                title="Replay a recorded session"
                onClick={() => setShowReplay(true)}
                className="workspace-rail-button"
              >
                <History size={16} />
              </button>
              <button
                type="button"
                title="Canvas analytics"
                onClick={() => setShowAnalytics(true)}
                className="workspace-rail-button"
              >
                <BarChart3 size={16} />
              </button>
              {selectedPage.is_branch && (
                <button
                  type="button"
                  title="Diff this branch against its parent"
                  onClick={() => setDiffBranch(selectedPage)}
                  className="workspace-rail-button text-indigo-600"
                >
                  <GitCompare size={16} />
                </button>
              )}
              <button
                type="button"
                title="Export as PNG"
                onClick={() => handleExport('png')}
                className="workspace-rail-button"
              >
                <FileDown size={16} />
              </button>
              <button
                type="button"
                title="Export as PDF"
                onClick={() => handleExport('pdf')}
                className="workspace-rail-button"
              >
                <FileType size={16} />
              </button>
              <div className="workspace-rail-divider" />
            </>
          )}
          <button
            type="button"
            title="Sign out"
            onClick={handleLogout}
            className="workspace-rail-button danger"
          >
            <LogOut size={16} />
          </button>
        </div>
        <div className="flex-1">
          <CanvasBoard
            page={selectedPage}
            user={session.user}
            accessToken={session.accessToken}
            highlightElement={highlight}
          />
        </div>
        {showAudit && selectedPage && (
          <AuditPanel
            pageId={selectedPage.id}
            channel={selectedChannel}
            onClose={() => setShowAudit(false)}
            onHighlight={(elementId) => setHighlight({ id: elementId, nonce: Date.now() })}
          />
        )}
      </main>
      {showReplay && selectedPage && (
        <ReplayModal page={selectedPage} onClose={() => setShowReplay(false)} />
      )}
      {showAnalytics && selectedPage && (
        <AnalyticsModal page={selectedPage} onClose={() => setShowAnalytics(false)} />
      )}
      {diffBranch && (
        <BranchDiffModal
          branch={diffBranch}
          parentTitle={diffParentTitle}
          onClose={() => setDiffBranch(null)}
          onMerged={refreshChannelDetail}
        />
      )}
    </div>
  )
}

export default App
