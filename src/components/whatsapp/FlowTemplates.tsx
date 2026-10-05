// Glific-style pre-built flow templates; picking one creates a pre-filled flow.

import { X } from 'lucide-react'
import type { WaFlow } from '../../types/whatsapp'

interface TemplateCard {
  id:          string
  name:        string
  description: string
  icon:        string
  tags:        string[]
  flow:        Omit<WaFlow, 'id'>
}

const TEMPLATES: TemplateCard[] = [
  // ── Welcome & Registration ───────────────────────────────────────────────
  {
    id: 'welcome',
    name: 'Welcome & Registration',
    description: 'Greet new contacts and collect their name, location, and role.',
    icon: '👋',
    tags: ['onboarding', 'registration'],
    flow: {
      name: 'Welcome Flow',
      description: 'Welcome new contacts and collect basic info',
      trigger_keywords: ['hi', 'hello', 'start', 'help', 'नमस्ते'],
      is_default: true,
      is_active: false,
      nodes: [
        {
          id: 'n1', type: 'send_message', node_label: 'Welcome greeting',
          text: 'नमस्ते {{contact.name}}! 🙏 Welcome to *Jaljeevika FieldFlow*.\n\nI can help you submit field reports, view updates, and more.',
          next: 'n2',
        },
        {
          id: 'n2', type: 'send_buttons', node_label: 'Main menu',
          text: 'What would you like to do?',
          save_as: 'main_choice',
          buttons: [
            { id: 'report', title: '📝 Submit Report' },
            { id: 'help',   title: 'ℹ️ Help' },
          ],
          next: 'n3',
        },
        {
          id: 'n3', type: 'condition', node_label: 'Route choice',
          variable: 'main_choice', operator: 'equals', value: 'report',
          next_true: 'n4', next_false: 'n5',
        },
        {
          id: 'n4', type: 'enter_flow', node_label: 'Go to report flow',
          flow_name: 'Field Report Flow',
        },
        {
          id: 'n5', type: 'end', node_label: 'Help & end',
          text: 'You can send *report* any time to submit a field report.\nReply *hi* to restart. 🙏',
        },
      ],
    },
  },

  // ── Field Report Collection ───────────────────────────────────────────────
  {
    id: 'field_report',
    name: 'Field Report Collection',
    description: 'Collect village visits, beneficiaries, activities, and location from field staff.',
    icon: '📝',
    tags: ['field', 'reporting'],
    flow: {
      name: 'Field Report Flow',
      description: 'Collect structured field activity report',
      trigger_keywords: ['report', 'rept', 'रिपोर्ट', 'submit'],
      is_default: false,
      is_active: false,
      nodes: [
        {
          id: 'n1', type: 'send_message', node_label: 'Start report',
          text: '📋 *Field Activity Report*\n\nI\'ll collect your field visit details. Let\'s begin!',
          next: 'n2',
        },
        {
          id: 'n2', type: 'wait_input', node_label: 'Ask village/location',
          text: '📍 Which village or location did you visit today?',
          save_as: 'village', validation: 'text',
          next: 'n3',
        },
        {
          id: 'n3', type: 'wait_input', node_label: 'Ask beneficiaries count',
          text: '👥 How many beneficiaries did you meet?',
          save_as: 'beneficiaries', validation: 'number',
          next: 'n4',
        },
        {
          id: 'n4', type: 'send_list', node_label: 'Select activity type',
          header: 'Activity Type',
          text: 'What type of activity did you conduct?',
          button_text: 'Select',
          section_title: 'Activities',
          save_as: 'activity_type',
          options: [
            { id: 'training',     title: 'Training / Workshop',    description: 'Capacity building session' },
            { id: 'survey',       title: 'Household Survey',        description: 'Data collection' },
            { id: 'distribution', title: 'Material Distribution',   description: 'Kit / input distribution' },
            { id: 'meeting',      title: 'Community Meeting',       description: 'SHG / village meeting' },
            { id: 'other',        title: 'Other Activity',          description: 'Any other activity' },
          ],
          next: 'n5',
        },
        {
          id: 'n5', type: 'wait_input', node_label: 'Activity description',
          text: '📝 Briefly describe what happened (2-3 sentences):',
          save_as: 'description', validation: 'text',
          next: 'n6',
        },
        {
          id: 'n6', type: 'webhook', node_label: 'Submit to backend',
          method: 'POST',
          url: 'https://chatbot-492915.el.r.appspot.com/api/wa/webhook-submit',
          body: {
            phone: '{{contact.wa_id}}',
            name: '{{contact.name}}',
            village: '{{village}}',
            beneficiaries: '{{beneficiaries}}',
            activity_type: '{{activity_type}}',
            description: '{{description}}',
          },
          next: 'n7',
          next_on_error: 'n7',
        },
        {
          id: 'n7', type: 'add_label', node_label: 'Tag as reported',
          label: 'reported',
          next: 'n8',
        },
        {
          id: 'n8', type: 'end', node_label: 'Confirmation',
          text: '✅ *Report submitted successfully!*\n\n📍 Village: {{village}}\n👥 Beneficiaries: {{beneficiaries}}\n🎯 Activity: {{activity_type}}\n\nThank you! Reply *report* anytime to submit another. 🙏',
        },
      ],
    },
  },

  // ── Beneficiary Survey ────────────────────────────────────────────────────
  {
    id: 'survey',
    name: 'Beneficiary Survey',
    description: 'Collect feedback and satisfaction ratings from program beneficiaries.',
    icon: '📊',
    tags: ['survey', 'feedback', 'M&E'],
    flow: {
      name: 'Beneficiary Survey',
      description: 'Collect satisfaction and outcome survey from beneficiaries',
      trigger_keywords: ['survey', 'feedback', 'सर्वे'],
      is_default: false,
      is_active: false,
      nodes: [
        {
          id: 'n1', type: 'send_message', node_label: 'Intro',
          text: '📊 *Beneficiary Survey*\n\nThis will take 2 minutes. Your feedback helps us improve our programs. Thank you!',
          next: 'n2',
        },
        {
          id: 'n2', type: 'send_buttons', node_label: 'Satisfaction rating',
          text: 'How satisfied are you with the support you received?',
          save_as: 'satisfaction',
          buttons: [
            { id: 'very_satisfied', title: '😊 Very satisfied' },
            { id: 'satisfied',      title: '🙂 Satisfied' },
            { id: 'not_satisfied',  title: '😐 Not satisfied' },
          ],
          next: 'n3',
        },
        {
          id: 'n3', type: 'send_buttons', node_label: 'Income change',
          text: 'Has your household income changed since joining the program?',
          save_as: 'income_change',
          buttons: [
            { id: 'increased', title: '📈 Increased' },
            { id: 'same',      title: '➡️ Same' },
            { id: 'decreased', title: '📉 Decreased' },
          ],
          next: 'n4',
        },
        {
          id: 'n4', type: 'wait_input', node_label: 'Open feedback',
          text: '💬 Any suggestions or comments for the program team? (or type *skip*)',
          save_as: 'comments', validation: 'text',
          next: 'n5',
        },
        {
          id: 'n5', type: 'add_label', node_label: 'Tag as surveyed',
          label: 'surveyed',
          next: 'n6',
        },
        {
          id: 'n6', type: 'end', node_label: 'Thank you',
          text: '🙏 *Thank you for your feedback!*\n\nSatisfaction: {{satisfaction}}\nIncome change: {{income_change}}\n\nYour input helps us serve you better.',
        },
      ],
    },
  },

  // ── Opt-out Handler ───────────────────────────────────────────────────────
  {
    id: 'optout',
    name: 'Opt-out Handler',
    description: 'Let contacts unsubscribe from messages with a simple keyword.',
    icon: '🚫',
    tags: ['compliance', 'opt-out'],
    flow: {
      name: 'Opt-out Flow',
      description: 'Handle STOP / unsubscribe requests',
      trigger_keywords: ['stop', 'unsubscribe', 'optout', 'opt out', 'बंद'],
      is_default: false,
      is_active: false,
      nodes: [
        {
          id: 'n1', type: 'send_message', node_label: 'Confirm opt-out',
          text: '⚠️ You\'ve requested to stop receiving messages from us.',
          next: 'n2',
        },
        {
          id: 'n2', type: 'set_field', node_label: 'Mark opted_out',
          field: 'opted_out', value: 'true',
          next: 'n3',
        },
        {
          id: 'n3', type: 'add_label', node_label: 'Tag opted-out',
          label: 'opted-out',
          next: 'n4',
        },
        {
          id: 'n4', type: 'end', node_label: 'Goodbye',
          text: 'You have been unsubscribed. You won\'t receive automated messages anymore.\n\nReply *start* anytime to resubscribe. 🙏',
        },
      ],
    },
  },

  // ── Quick Poll ────────────────────────────────────────────────────────────
  {
    id: 'quick_poll',
    name: 'Quick Poll / Quiz',
    description: 'Run a simple poll with button choices and collect responses.',
    icon: '🗳️',
    tags: ['poll', 'quiz', 'engagement'],
    flow: {
      name: 'Quick Poll',
      description: 'Simple single-question poll with button choices',
      trigger_keywords: ['poll', 'vote', 'quiz'],
      is_default: false,
      is_active: false,
      nodes: [
        {
          id: 'n1', type: 'send_message', node_label: 'Poll intro',
          text: '🗳️ *Quick Poll*\n\nWe\'d love your opinion! This takes 10 seconds.',
          next: 'n2',
        },
        {
          id: 'n2', type: 'send_buttons', node_label: 'Poll question',
          text: 'Which area needs the most support in your community?',
          save_as: 'poll_answer',
          buttons: [
            { id: 'water',     title: '💧 Water & Sanitation' },
            { id: 'livelihood', title: '🌾 Livelihood' },
            { id: 'health',    title: '🏥 Health' },
          ],
          next: 'n3',
        },
        {
          id: 'n3', type: 'add_label', node_label: 'Tag poll answered',
          label: 'poll-answered',
          next: 'n4',
        },
        {
          id: 'n4', type: 'end', node_label: 'Thank you',
          text: '✅ Thank you for your vote: *{{poll_answer}}*\n\nYour response has been recorded. We\'ll share results soon! 🙏',
        },
      ],
    },
  },
]

interface Props {
  onSelect: (flow: Omit<WaFlow, 'id'>) => void
  onClose:  () => void
}

export function FlowTemplates({ onSelect, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-xl border border-[#D9E6E8] shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-serif font-semibold text-gray-900 text-lg">Flow Templates</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pick a template to get started quickly</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-gray-100 transition">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 grid gap-3 sm:grid-cols-2">
          {TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => { onSelect(t.flow); onClose() }}
              className="text-left p-4 rounded-xl border border-[#D9E6E8] hover:border-purple-300 hover:shadow-md transition-all group"
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl shrink-0">{t.icon}</div>
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 text-sm group-hover:text-purple-700 transition">
                    {t.name}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                    {t.description}
                  </div>
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {t.tags.map(tag => (
                      <span key={tag} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">
                        {tag}
                      </span>
                    ))}
                    <span className="text-[9px] text-gray-400 px-1.5 py-0.5">
                      {t.flow.nodes.length} nodes
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 text-xs text-gray-400 text-center shrink-0">
          You can edit, rename, and customise any template after selecting it
        </div>
      </div>
    </div>
  )
}
