export type MemberRole = 'owner' | 'admin' | 'editor' | 'viewer'

export type User = {
  id: string
  email: string
  display_name: string
  avatar_url?: string | null
}

export type ChannelListItem = {
  id: string
  name: string
  description?: string | null
  owner_id: string
  is_private: boolean
  invite_code?: string | null
  created_at: string
  role: MemberRole
}

export type ChannelDetail = ChannelListItem & {
  members: Array<{
    user_id: string
    email: string
    display_name: string
    avatar_url?: string | null
    role: MemberRole
    joined_at: string
  }>
  pages: PageSummary[]
}

export type PageSummary = {
  id: string
  title: string
  order_index: number
  is_branch: boolean
  branch_of?: string | null
  created_at: string
}

export type ElementType =
  | 'stroke'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'image'
  | 'math'
  | 'sticky'
  | 'arrow'
  | 'link'

export type ElementTransform = {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type ElementStyle = {
  stroke?: string
  fill?: string
  strokeWidth?: number
}

export type Element = {
  id: string
  page_id: string
  created_by?: string | null
  type: ElementType
  transform: ElementTransform
  style: ElementStyle
  content: Record<string, unknown>
  locked_by?: string | null
  is_deleted: boolean
  last_event?: string | null
  created_at: string
  updated_at: string
}

export type AuthSession = {
  accessToken: string
  refreshToken: string
  user: User
}

export type AuthConfig = {
  google_enabled: boolean
  google_client_id: string
  institutional_domains: string[]
}

export type EventOperation = 'create' | 'update' | 'delete' | 'lock' | 'unlock' | 'restore'

export type ElementEvent = {
  id: string
  element_id: string
  page_id: string
  actor_id?: string | null
  actor_display_name?: string | null
  operation: EventOperation
  before_state?: Record<string, unknown> | null
  after_state?: Record<string, unknown> | null
  vector_clock: Record<string, number>
  occurred_at: string
}

export type AuditPageResult = {
  items: ElementEvent[]
  limit: number
  offset: number
  total: number
}

export type SessionSummary = {
  id: string
  page_id: string
  started_at: string
  ended_at?: string | null
}

export type ReplayEvent = {
  id: number
  event_type: string
  payload: Record<string, unknown>
  actor_id?: string | null
  occurred_at: string
}

export type BranchDiff = {
  added: Element[]
  modified: Array<{ parent: Element; branch: Element }>
  deleted: Element[]
}

export type MergeStrategy = 'ours' | 'theirs'

export type MergeSummary = {
  strategy: MergeStrategy
  added_count: number
  modified_count: number
  deleted_count: number
}

export type Invite = {
  id: string
  channel_id: string
  code: string
  invite_url: string
  role_on_join: MemberRole
  max_uses?: number | null
  uses_count: number
  expires_at?: string | null
  created_at: string
}

export type AITriggerType = 'math' | 'image' | 'question' | 'text_block' | 'closed_shape' | 'explicit'

export type HeatmapCell = {
  region_x_bucket: number
  region_y_bucket: number
  total_edits: number
  unique_users: number
}

export type ParticipationEntry = {
  user_id: string
  display_name: string
  total_elements: number
  active_seconds: number
}

export type AITriggerUsage = {
  trigger_type: AITriggerType
  count: number
  avg_latency_ms?: number | null
}

export type PageAnalytics = {
  heatmap: HeatmapCell[]
  participation: ParticipationEntry[]
  most_active_day?: string | null
  ai_usage: {
    by_trigger_type: AITriggerUsage[]
    total_interactions: number
    incorrect_feedback_percentage?: number | null
  }
}

export type AISolveItem = {
  problem: string
  answer: string
  x?: number | null
  y?: number | null
}

export type AISolveResponse = {
  source: 'gemini' | 'local' | 'local-fallback'
  answers: AISolveItem[]
  latency_ms: number
}

export type AIInteraction = {
  id: string
  page_id: string
  trigger_element_id?: string | null
  trigger_type: AITriggerType
  canvas_snapshot_url?: string | null
  prompt_sent: string
  response_json?: Record<string, unknown> | null
  response_element_id?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  latency_ms?: number | null
  status: string
  error_message?: string | null
  created_at: string
}
