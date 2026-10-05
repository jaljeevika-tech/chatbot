export type NodeType =
  | 'send_message'
  | 'send_list'
  | 'send_buttons'
  | 'wait_input'
  | 'condition'
  | 'webhook'
  | 'set_field'
  | 'delay'
  | 'add_label'
  | 'enter_flow'
  | 'human_handoff'
  | 'call_llm'
  | 'llm_router'
  | 'random_split'
  | 'recap_confirm'
  | 'update_contact'
  | 'remove_label'
  | 'end'

export interface ListOption {
  id:           string
  title:        string
  description?: string
}

export interface ButtonOption {
  id:    string
  title: string
}

export interface FlowNode {
  id:          string
  type:        NodeType
  // user-visible node name (shown in Next Node selector)
  node_label?: string
  // send_message / wait_input / end
  text?:       string
  // send_list
  header?:     string
  button_text?: string
  section_title?: string
  options?:    ListOption[]
  // send_buttons
  buttons?:    ButtonOption[]
  // wait_input
  save_as?:    string
  validation?: 'text' | 'number' | 'phone' | 'image'
  example?:    string   // shown to user as "_e.g. <example>_" after the prompt
  // condition
  variable?:   string
  operator?:   'equals' | 'contains' | 'starts_with' | 'not_empty' | 'is_number'
  value?:      string
  next_true?:  string
  next_false?: string
  // webhook
  url?:        string
  method?:     'POST' | 'GET'
  body?:       Record<string, string>
  headers?:    Record<string, string>
  next_on_error?: string
  // set_field
  field?:      string
  // delay  (Glific: wait_for_time)
  delay_seconds?: number
  // add_label (Glific: add_contact_groups)
  label?:      string
  // enter_flow (Glific: enter_flow)
  flow_name?:  string
  // human_handoff (Glific: open_ticket) — escalate to live agent
  notify_message?: string   // sent to contact ("An agent will reply shortly")
  notify_staff_phone?: string  // optional WA id to ping
  assign_to_users?: string[]   // user UUIDs to assign (first one wins; round-robin in future)
  // call_llm (Glific: callllm) — run a Gemini prompt inside a flow
  llm_prompt?:        string   // user-supplied prompt; supports {{variables}}
  llm_system_prompt?: string   // optional system instruction
  llm_max_tokens?:    number   // default 512, cap 2048
  llm_send_reply?:    boolean  // if true, also send response to contact
  // llm_router (Glific: LLM router) — classify input and branch
  llm_categories?:    { label: string; next: string }[]  // ordered list of categories
  default_next?:      string                              // fallback if none match
  // random_split — A/B test branching
  random_branches?:   { weight: number; label: string; next: string }[]
  // condition (extended) — N-way switch (caselist)
  // existing `operator` + `value` + `next_true`/`next_false` still work; if cases is present, it overrides them.
  cases?:             { operator: 'equals' | 'contains' | 'starts_with' | 'not_empty' | 'is_number'; value: string; next: string }[]
  // recap_confirm — summarise collected vars and wait for YES/EDIT
  field_labels?:      Record<string, string>   // pretty names for collected variables
  intro_text?:        string                    // optional intro line before the summary
  yes_label?:         string                    // default "YES"
  edit_label?:        string                    // default "EDIT"
  next_edit?:         string                    // node id to jump to on EDIT
  // generic next
  next?:       string
}

export interface WaFlow {
  id?:              string
  name:             string
  description?:     string
  trigger_keywords: string[]
  is_default?:      boolean
  nodes:            FlowNode[]
  is_active?:       boolean
  node_count?:      number
  created_at?:      string
  updated_at?:      string
  // Flow-level UX toggle — prepends [Q n/m] to question prompts
  show_progress?:   boolean
}

export interface WaContact {
  id:            string
  wa_id:         string
  name:          string | null
  fields:        Record<string, string>
  opted_in:      boolean
  tags:          string[]
  last_seen:     string
  message_count: number
  last_message_at: string | null
}

export interface WaMessage {
  id:            string
  direction:     'inbound' | 'outbound'
  type:          string
  content:       Record<string, unknown>
  status:        string
  created_at:    string
}

export interface WaStats {
  contacts:          number
  inboundMessages:   number
  outboundMessages:  number
  activeFlows:       number
  totalFlows:        number
  completedSessions: number
  activeSessions:    number
}

export interface ConversationItem {
  id:                     string
  wa_id:                  string
  name:                   string | null
  tags:                   string[]
  opted_in:               boolean
  last_seen:              string
  fields:                 Record<string, string>
  last_message_content:   Record<string, unknown> | null
  last_message_direction: 'inbound' | 'outbound' | null
  last_message_at:        string | null
  last_message_type:      string | null
  session_id:             string | null
  session_status:         string | null
  flow_id:                string | null
  flow_name:              string | null
  current_node:           string | null
  message_count:          number
  assigned_to:            string | null
  assigned_to_name:       string | null
}

export const NODE_META: Record<NodeType, { label: string; icon: string; color: string }> = {
  send_message: { label: 'Send Message',   icon: '💬', color: '#3b82f6' },
  send_list:    { label: 'List Selection', icon: '📋', color: '#8b5cf6' },
  send_buttons: { label: 'Button Choice',  icon: '🔘', color: '#6366f1' },
  wait_input:   { label: 'Wait for Input', icon: '✏️', color: '#f59e0b' },
  condition:    { label: 'Condition',      icon: '🔀', color: '#ec4899' },
  webhook:      { label: 'Webhook Call',   icon: '🌐', color: '#10b981' },
  set_field:    { label: 'Set Variable',   icon: '📌', color: '#14b8a6' },
  delay:        { label: 'Delay / Wait',   icon: '⏱️', color: '#f97316' },
  add_label:    { label: 'Add Label',      icon: '🏷️', color: '#06b6d4' },
  enter_flow:   { label: 'Enter Sub-Flow', icon: '↗️', color: '#a855f7' },
  human_handoff:{ label: 'Human Handoff',  icon: '🙋', color: '#ef4444' },
  call_llm:     { label: 'AI Reply (LLM)', icon: '✨', color: '#9333ea' },
  llm_router:   { label: 'AI Router',      icon: '🧠', color: '#7c3aed' },
  random_split: { label: 'Random Split',   icon: '🎲', color: '#0891b2' },
  recap_confirm:{ label: 'Recap & Confirm',icon: '📋', color: '#14b8a6' },
  update_contact:{label: 'Update Contact', icon: '🟢', color: '#10b981' },
  remove_label: { label: 'Remove from Collection', icon: '🏷', color: '#64748b' },
  end:          { label: 'End Flow',       icon: '🔚', color: '#6b7280' },
}
