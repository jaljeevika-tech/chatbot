// POST /api/wa/flows/generate — Gemini (JSON mode) turns a prompt into FlowNode[]
// for FlowBuilderCanvas / flowEngine.js. Preview only; nothing is written to the DB.

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { callGemini } from '../lib/nlp.js'

const router = Router()

// System prompt enumerates every node type and constraint so Gemini emits
// runnable JSON. Keep in sync with src/types/whatsapp.ts and lib/flowEngine.js.
const SYSTEM_PROMPT = `You generate WhatsApp chatbot flow definitions for an NGO platform.

Output JSON: {"name": "...", "description": "...", "trigger_keywords": ["..."], "nodes": [...]}.
- name: short, human-readable, 3-40 chars
- description: one sentence explaining what the flow does
- trigger_keywords: 1-5 lowercase single-word triggers a contact would send to start this flow
- nodes: an ORDERED ARRAY of node objects (see schema below)

Each node has: { id, type, ...type-specific fields, next?, save_as? }
- id: unique slug like "n1", "n2", "ask_name", "if_yes"
- next: id of the next node ("end" implicit if omitted on terminal nodes)

Supported types and their fields:
- send_message: { text: "...", next: "..." }
- wait_input: { text: "prompt to contact", save_as: "variable_name", validation: "text"|"number"|"phone", next: "..." }
- send_buttons: { text: "...", buttons: [{id:"1",title:"Yes"},{id:"2",title:"No"}], save_as: "var", next: "..." }
- send_list: { header, text, button_text, section_title, options:[{id,title,description}], save_as, next }
- condition: { variable: "name", operator: "equals"|"contains"|"starts_with"|"not_empty"|"is_number", value: "...", next_true: "...", next_false: "..." }
- set_field: { field: "name", value: "..." (supports {{vars}}), next }
- add_label: { label: "tag-name", next }
- delay: { delay_seconds: 5, next }
- webhook: { method:"POST"|"GET", url:"...", headers:{}, body:{}, save_as:"resp", next, next_on_error }
- call_llm: { llm_prompt: "...", llm_system_prompt: "...", save_as: "ai_reply", llm_send_reply: true, llm_max_tokens: 512, next }
- llm_router: { llm_prompt:"{{__last_text}}", llm_categories:[{label:"a",next:"node_id"},...], default_next:"...", save_as:"route" }
- random_split: { random_branches:[{weight:50,label:"A",next:"..."}], save_as:"variant" }
- human_handoff: { notify_message: "...", notify_staff_phone: "" }
- end: { text: "Thank you!" }

Variable interpolation: use {{variable_name}} inside text fields. {{contact.name}} is always available.

Rules:
1. Every node must have a valid "next" pointing to another node id, except: condition (uses next_true/next_false), llm_router (uses llm_categories[].next + default_next), random_split (uses random_branches[].next), human_handoff and end (terminal).
2. The flow must be CONNECTED — every non-terminal node leads to a terminal one.
3. Keep it concise — between 3 and 12 nodes. Don't over-engineer.
4. Use {{collected_var}} interpolation to personalize messages.
5. Use call_llm when the user prompt asks for AI-generated content (summaries, recommendations, translations).
6. Use llm_router when the user wants to branch on free-form input.
7. Use human_handoff when the user mentions "live agent", "human", "talk to someone", "escalate".

Reply with VALID JSON ONLY — no markdown, no explanation, no preamble.`

router.post('/wa/flows/generate', async (req, res) => {
  const { prompt } = req.body || {}
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'prompt is required (min 5 chars)' })
  }

  try {
    const userPrompt = `Build this WhatsApp flow:\n\n${prompt.trim()}`
    const result = await callGemini(userPrompt, SYSTEM_PROMPT, 2048, true, 30_000)

    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'AI did not return a valid flow. Try rephrasing.' })
    }

    // Normalise: ensure each node has a stable id, drop any malformed
    if (!Array.isArray(result.nodes) || result.nodes.length === 0) {
      return res.status(502).json({ error: 'AI returned no nodes.' })
    }
    const validTypes = new Set([
      'send_message','wait_input','send_buttons','send_list','condition',
      'set_field','add_label','delay','webhook','call_llm','llm_router',
      'random_split','human_handoff','enter_flow','end'
    ])
    result.nodes = result.nodes
      .filter(n => n && validTypes.has(n.type))
      .map(n => ({ ...n, id: n.id || `n_${randomUUID().slice(0, 8)}` }))

    if (result.nodes.length === 0) {
      return res.status(502).json({ error: 'AI returned only unsupported node types.' })
    }

    res.json({
      name: String(result.name || 'Generated flow').slice(0, 80),
      description: String(result.description || '').slice(0, 240),
      trigger_keywords: Array.isArray(result.trigger_keywords)
        ? result.trigger_keywords.filter(k => typeof k === 'string').slice(0, 8)
        : [],
      nodes: result.nodes,
    })
  } catch (e) {
    console.warn('[flow-generator]', e.message)
    res.status(500).json({ error: 'Generation failed: ' + e.message })
  }
})

export default router
