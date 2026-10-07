// Types for lib/odkForm.js (shared with the web renderer).

export interface FormRow {
  type: string; name: string; label?: string; hint?: string; required?: boolean; list?: string
  relevant?: string; constraint?: string; constraint_message?: string; calculation?: string
  repeat_count?: string; default?: string; appearance?: string; archived?: boolean; system?: boolean; column?: string
}
export interface FormChoice { name: string; label: string }
export interface FormSchema { settings: { form_title: string }; survey: FormRow[]; choices: Record<string, FormChoice[]> }
export type Answers = Record<string, unknown>

export interface TreeNode { row: FormRow; children: TreeNode[] }

export function compile(src: string): unknown
export function checkExpr(src: string): string | null
export function buildTree(survey: FormRow[]): { tree: TreeNode[]; defs: Record<string, { row: FormRow; repeats: string[] }> }
export function evaluateForm(schema: FormSchema, input: Answers): {
  data: Answers
  errors: Record<string, string>
  relevant: Record<string, boolean>
  repeatCounts: Record<string, number>
}
