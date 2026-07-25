import { BookOpen, Folder, GitBranch, Link2, Plus, SquarePen, UserRound, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { acceptInvite, createInvite, removeMember, updateMemberRole } from '../lib/api'
import type { ChannelDetail, ChannelListItem, MemberRole, PageSummary, User } from '../types'

type SidebarProps = {
  user: User
  channels: ChannelListItem[]
  selectedChannel?: ChannelDetail | null
  selectedPage?: PageSummary | null
  onSelectChannel: (channelId: string) => void
  onCreateChannel: (payload: { name: string; description?: string }) => void
  onSelectPage: (pageId: string) => void
  onCreatePage: (title: string) => void
  onCreateBranch: (pageId: string) => void
  onChannelChanged: () => void
  onChannelsChanged: () => void
  onlineUserIds?: string[]
}

const ASSIGNABLE_ROLES: MemberRole[] = ['admin', 'editor', 'viewer']

const Sidebar = ({
  user,
  channels,
  selectedChannel,
  selectedPage,
  onSelectChannel,
  onCreateChannel,
  onSelectPage,
  onCreatePage,
  onCreateBranch,
  onChannelChanged,
  onChannelsChanged,
  onlineUserIds = [],
}: SidebarProps) => {
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelDescription, setNewChannelDescription] = useState('')
  const [newPageTitle, setNewPageTitle] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [showMembers, setShowMembers] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const channelRole = selectedChannel?.role?.toUpperCase() ?? 'VIEWER'
  const canManageMembers = selectedChannel?.role === 'owner' || selectedChannel?.role === 'admin'
  const membersCount = selectedChannel?.members.length ?? 0

  const flash = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 3500)
  }

  const { rootPages, branchesByParent } = useMemo(() => {
    const pages = selectedChannel ? [...selectedChannel.pages] : []
    const roots = pages
      .filter((page) => !page.is_branch)
      .sort((a, b) => a.order_index - b.order_index)
    const byParent = new Map<string, PageSummary[]>()
    pages
      .filter((page) => page.is_branch)
      .forEach((branch) => {
        const parentId = branch.branch_of ?? ''
        byParent.set(parentId, [...(byParent.get(parentId) ?? []), branch])
      })
    return { rootPages: roots, branchesByParent: byParent }
  }, [selectedChannel])

  const handleCopyInvite = async () => {
    if (!selectedChannel) return
    try {
      const invite = await createInvite(selectedChannel.id)
      try {
        await navigator.clipboard.writeText(invite.code)
        flash(`Invite code ${invite.code} copied — share it with a teammate.`)
      } catch {
        flash(`Invite code: ${invite.code}`)
      }
    } catch {
      flash('Only admins can create invites.')
    }
  }

  const handleJoinWithCode = async () => {
    const code = inviteCode.trim()
    if (!code) return
    try {
      const channel = await acceptInvite(code)
      setInviteCode('')
      flash(`Joined ${channel.name}.`)
      onChannelsChanged()
    } catch {
      flash('Invite code is invalid, expired, or used up.')
    }
  }

  const handleRoleChange = async (memberId: string, role: MemberRole) => {
    if (!selectedChannel) return
    try {
      await updateMemberRole(selectedChannel.id, memberId, role)
      onChannelChanged()
    } catch {
      flash('You are not allowed to assign that role.')
    }
  }

  const handleRemoveMember = async (memberId: string, name: string) => {
    if (!selectedChannel) return
    if (!window.confirm(`Remove ${name} from this channel?`)) return
    try {
      await removeMember(selectedChannel.id, memberId)
      onChannelChanged()
    } catch {
      flash('You are not allowed to remove that member.')
    }
  }

  const renderPageRow = (page: PageSummary, isBranch: boolean) => (
    <div key={page.id} className={`group relative ${isBranch ? 'ml-5' : ''}`}>
      <button
        type="button"
        onClick={() => onSelectPage(page.id)}
        className={`workspace-list-item ${selectedPage?.id === page.id ? 'active' : ''}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {isBranch && <GitBranch size={13} className="shrink-0 text-indigo-400" />}
          <span className="truncate font-medium">{page.title}</span>
        </span>
        <SquarePen size={14} className="shrink-0 text-slate-500" />
      </button>
      {!isBranch && selectedChannel?.role !== 'viewer' && (
        <button
          type="button"
          title="Create a branch of this page"
          onClick={() => onCreateBranch(page.id)}
          className="absolute right-8 top-1/2 hidden -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 group-hover:block"
        >
          <GitBranch size={14} />
        </button>
      )}
    </div>
  )

  return (
    <aside className="workspace-sidebar flex h-full w-80 flex-col gap-5 overflow-y-auto p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Notebook Index</p>
        <h1 className="mt-2 font-reading-serif text-3xl uppercase tracking-[0.16em] text-indigo-950/20">Canvex</h1>
        <p className="mt-1 text-sm text-slate-500">Realtime research pages</p>
      </div>

      <div className="workspace-user-strip">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
              <UserRound size={17} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{user.display_name}</p>
              <p className="truncate text-xs text-slate-400">{user.email}</p>
            </div>
          </div>
          <span className="workspace-chip">{channelRole}</span>
        </div>
        {selectedChannel && (
          <button
            type="button"
            onClick={() => setShowMembers((prev) => !prev)}
            className="mt-3 flex w-full items-center gap-2 text-xs text-slate-500 hover:text-indigo-600"
          >
            <Users size={13} />
            <span>{membersCount} members</span>
            <span>•</span>
            <span>{selectedChannel.pages.length} pages</span>
            <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
              {showMembers ? 'hide' : 'manage'}
            </span>
          </button>
        )}

        {showMembers && selectedChannel && (
          <div className="mt-3 space-y-2 border-t border-slate-200/80 pt-3">
            {selectedChannel.members.map((member) => {
              const isSelf = member.user_id === user.id
              const isOwner = member.role === 'owner'
              const editable = canManageMembers && !isOwner && !isSelf
              const isOnline = onlineUserIds.includes(member.user_id)
              return (
                <div key={member.user_id} className="flex items-center gap-2">
                  <div className="relative shrink-0">
                    <div className="workspace-avatar muted h-7 w-7 text-[10px]">
                      {member.display_name.slice(0, 2).toUpperCase()}
                    </div>
                    {isOnline && (
                      <span
                        title="On this page now"
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500"
                      />
                    )}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                    {member.display_name}
                    {isSelf && <span className="text-slate-400"> (you)</span>}
                  </span>
                  {editable ? (
                    <select
                      className="rounded border border-slate-200 bg-white/70 px-1 py-0.5 text-[11px] text-slate-600 outline-none focus:border-indigo-300"
                      value={member.role}
                      onChange={(event) => handleRoleChange(member.user_id, event.target.value as MemberRole)}
                    >
                      {ASSIGNABLE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {member.role}
                    </span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      title={`Remove ${member.display_name}`}
                      onClick={() => handleRemoveMember(member.user_id, member.display_name)}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              )
            })}
            {canManageMembers && (
              <button type="button" onClick={handleCopyInvite} className="workspace-action-button w-full justify-center text-xs">
                <Link2 size={14} />
                Copy invite code
              </button>
            )}
          </div>
        )}
      </div>

      {notice && <p className="text-xs font-medium text-indigo-700">{notice}</p>}

      <section>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          <Folder size={14} />
          Channels
        </div>
        <div className="mt-3 space-y-2">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelectChannel(channel.id)}
              className={`workspace-list-item ${selectedChannel?.id === channel.id ? 'active' : ''}`}
            >
              <span className="font-medium">{channel.name}</span>
              <span className="text-xs text-slate-400">{channel.role}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <input
            className="workspace-input"
            placeholder="New channel"
            value={newChannelName}
            onChange={(event) => setNewChannelName(event.target.value)}
          />
          <input
            className="workspace-input"
            placeholder="Description (optional)"
            value={newChannelDescription}
            onChange={(event) => setNewChannelDescription(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              if (!newChannelName.trim()) return
              const description = newChannelDescription.trim()
              onCreateChannel({ name: newChannelName.trim(), description: description || undefined })
              setNewChannelName('')
              setNewChannelDescription('')
            }}
            className="workspace-action-button w-full justify-center"
          >
            <Plus size={16} />
            Create channel
          </button>
          <div className="flex gap-2">
            <input
              className="workspace-input flex-1"
              placeholder="Invite code"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleJoinWithCode()
              }}
            />
            <button type="button" onClick={handleJoinWithCode} className="workspace-action-button shrink-0">
              Join
            </button>
          </div>
        </div>
      </section>

      <section className="flex-1">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          <BookOpen size={14} />
          Pages
        </div>
        <div className="mt-3 space-y-2">
          {rootPages.length === 0 && (
            <p className="text-sm text-slate-500">Select a channel to see pages.</p>
          )}
          {rootPages.map((page) => (
            <div key={page.id} className="space-y-1">
              {renderPageRow(page, false)}
              {(branchesByParent.get(page.id) ?? []).map((branch) => renderPageRow(branch, true))}
            </div>
          ))}
        </div>

        {selectedChannel && (
          <div className="mt-4 space-y-2">
            <input
              className="workspace-input"
              placeholder="New page title"
              value={newPageTitle}
              onChange={(event) => setNewPageTitle(event.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                if (!newPageTitle.trim()) return
                onCreatePage(newPageTitle.trim())
                setNewPageTitle('')
              }}
              className="workspace-action-button w-full justify-center"
            >
              <Plus size={16} />
              Create page
            </button>
          </div>
        )}
      </section>
    </aside>
  )
}

export default Sidebar
