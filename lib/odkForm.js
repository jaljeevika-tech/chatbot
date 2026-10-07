// lib/odkForm.js — ODK XPath expressions + form evaluation, shared by the web
// renderer (src/components/forms) and the server's submission check, so both
// apply skip logic, calculations, required and constraints identically.
// Plain JS with a sibling .d.ts so Vite/TS can import it from src/.
//
// Supported: ${name}, ., literals, or/and, = != < <= > >=, + - * div mod,
// unary -, and the ODK functions in FUNCS below. Anything else (raw XPath
// paths, unknown functions) is a parse error, so publish rejects it rather
// than the web form and ODK Collect silently disagreeing.
// ponytail: no full XPath (axes, predicates, /data/... paths); add if an org needs them.
//
// Answers model: flat { name: value } (groups don't nest), repeats as
// { repeat_name: [ { child: value, ... }, ... ] }, select_multiple as arrays.

// ── Tokenizer + parser ────────────────────────────────────────────────────────
const TOKEN_RE = /\s*(?:(\$\{[A-Za-z_][A-Za-z0-9_]*\})|(\d+(?:\.\d+)?|\.\d+)|('[^']*'|"[^"]*")|(!=|<=|>=|[=<>+\-*(),])|([A-Za-z_][A-Za-z0-9_.:-]*)|(\.)|(\S))/y

function tokenize(src) {
  const out = []
  TOKEN_RE.lastIndex = 0
  let m
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
    if (m[1]) out.push({ t: 'ref', v: m[1].slice(2, -1) })
    else if (m[2]) out.push({ t: 'num', v: Number(m[2]) })
    else if (m[3]) out.push({ t: 'str', v: m[3].slice(1, -1) })
    else if (m[4]) out.push({ t: 'op', v: m[4] })
    else if (m[5]) out.push({ t: 'id', v: m[5] })
    else if (m[6]) out.push({ t: 'self' })
    else if (m[7]) throw new SyntaxError(`unexpected "${m[7]}"`)
    else if (!m[0].trim()) break
  }
  return out
}

const LEVELS = [['or'], ['and'], ['=', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', 'div', 'mod']]

function parse(src) {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const isOp = (tok, ops) => tok && ((tok.t === 'op' && ops.includes(tok.v)) || (tok.t === 'id' && ops.includes(tok.v)))
  const expect = (v) => { const tok = toks[i++]; if (!tok || tok.v !== v) throw new SyntaxError(`expected "${v}"`); return tok }

  function level(n) {
    if (n === LEVELS.length) return unary()
    let left = level(n + 1)
    while (isOp(peek(), LEVELS[n])) { const op = toks[i++].v; left = { k: 'bin', op, a: left, b: level(n + 1) } }
    return left
  }
  function unary() {
    if (isOp(peek(), ['-'])) { i++; return { k: 'neg', a: unary() } }
    return primary()
  }
  function primary() {
    const tok = toks[i++]
    if (!tok) throw new SyntaxError('unexpected end of expression')
    if (tok.t === 'num' || tok.t === 'str') return { k: 'lit', v: tok.v }
    if (tok.t === 'ref') return { k: 'ref', name: tok.v }
    if (tok.t === 'self') return { k: 'self' }
    if (tok.t === 'op' && tok.v === '(') { const e = level(0); expect(')'); return e }
    if (tok.t === 'id' && peek()?.v === '(') {
      const fn = FUNCS[tok.v]
      if (!fn) throw new SyntaxError(`function ${tok.v}() isn't supported`)
      i++
      const args = []
      if (peek()?.v !== ')') { do args.push(level(0)); while (peek()?.v === ',' && i++) }
      expect(')')
      return { k: 'call', fn, name: tok.v, args }
    }
    throw new SyntaxError(tok.t === 'id' ? `"${tok.v}" isn't valid here; refer to questions as \${name}` : `unexpected "${tok.v}"`)
  }

  const ast = level(0)
  if (i < toks.length) throw new SyntaxError(`unexpected "${toks[i].v ?? '.'}"`)
  return ast
}

const cache = new Map()
export function compile(src) {
  let ast = cache.get(src)
  if (!ast) { ast = parse(String(src)); if (cache.size > 2000) cache.clear(); cache.set(src, ast) }
  return ast
}

/** Syntax check for the builder: error message, or null when the expression parses. */
export function checkExpr(src) {
  try { compile(src); return null } catch (e) { return e.message }
}

// ── Values (XPath 1.0: number | string | boolean | node-set as array of strings) ─
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/
const toStr = (v) => Array.isArray(v) ? (v.length ? toStr(v[0]) : '') : typeof v === 'boolean' ? String(v) : v == null ? '' : String(v)
// ODK converts dates to days since 1970-01-01, so ${dob} < today() and today() - ${dob} work.
function toNum(v) {
  if (Array.isArray(v)) return v.length ? toNum(v[0]) : NaN
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  if (s === '') return NaN
  const d = DATE_RE.exec(s)
  if (d) return Date.UTC(+d[1], d[2] - 1, +d[3], +(d[4] || 0), +(d[5] || 0), +(d[6] || 0)) / 86_400_000
  return Number(s)
}
const toBool = (v) => Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? !!v && !Number.isNaN(v) : typeof v === 'string' ? v.length > 0 : !!v

function compare(op, a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.some(x => b.some(y => compare(op, x, y)))
  if (Array.isArray(a) || Array.isArray(b)) {
    const [ns, other, flip] = Array.isArray(a) ? [a, b, false] : [b, a, true]
    if (typeof other === 'boolean') return compare(op, toBool(ns), other)
    return ns.some(node => (flip ? compare(op, other, node) : compare(op, node, other)))
  }
  if (op === '=' || op === '!=') {
    const eq = typeof a === 'boolean' || typeof b === 'boolean' ? toBool(a) === toBool(b)
      : typeof a === 'number' || typeof b === 'number' ? toNum(a) === toNum(b)
      : toStr(a) === toStr(b)
    return op === '=' ? eq : !eq
  }
  const x = toNum(a), y = toNum(b)
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y
}

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const nodes = (v) => (Array.isArray(v) ? v : [v])
const words = (v) => toStr(v).split(' ').filter(Boolean)

const FUNCS = {
  'selected':         (ns, v) => words(ns).includes(toStr(v)),
  'count-selected':   (ns) => words(ns).length,
  'selected-at':      (ns, n) => words(ns)[toNum(n)] ?? '',
  'count':            (ns) => nodes(ns).length,
  'count-non-empty':  (ns) => nodes(ns).filter(x => toStr(x) !== '').length,
  'sum':              (ns) => nodes(ns).reduce((s, x) => s + (toStr(x) === '' ? 0 : toNum(x)), 0),
  'max':              (...a) => Math.max(...a.flatMap(nodes).map(toNum)),
  'min':              (...a) => Math.min(...a.flatMap(nodes).map(toNum)),
  'join':             (sep, ns) => nodes(ns).map(toStr).join(toStr(sep)),
  'string-length':    (s) => toStr(s).length,
  'concat':           (...a) => a.map(x => nodes(x).map(toStr).join('')).join(''),
  'contains':         (s, t) => toStr(s).includes(toStr(t)),
  'starts-with':      (s, t) => toStr(s).startsWith(toStr(t)),
  'ends-with':        (s, t) => toStr(s).endsWith(toStr(t)),
  'substr':           (s, a, b) => toStr(s).slice(toNum(a), b === undefined ? undefined : toNum(b)),
  'substring-before': (s, t) => { const x = toStr(s), i = x.indexOf(toStr(t)); return i < 0 ? '' : x.slice(0, i) },
  'substring-after':  (s, t) => { const x = toStr(s), i = x.indexOf(toStr(t)); return i < 0 ? '' : x.slice(i + toStr(t).length) },
  'normalize-space':  (s) => toStr(s).trim().replace(/\s+/g, ' '),
  // ponytail: admin-authored pattern on input capped at 2000 chars; add a regex timeout if orgs write pathological patterns.
  'regex':            (s, p) => { try { return new RegExp(toStr(p)).test(toStr(s)) } catch { return false } },
  'if':               (c, a, b) => (toBool(c) ? a : b),
  'coalesce':         (a, b) => (toStr(a) !== '' ? a : b),
  'not':              (b) => !toBool(b),
  'true':             () => true,
  'false':            () => false,
  'boolean':          (v) => toBool(v),
  'boolean-from-string': (s) => ['true', '1'].includes(toStr(s)),
  'number':           (v) => toNum(v),
  'string':           (v) => toStr(v),
  'int':              (v) => Math.trunc(toNum(v)),
  'round':            (v, d) => { const f = 10 ** (d === undefined ? 0 : toNum(d)); return Math.round(toNum(v) * f) / f },
  'floor':            (v) => Math.floor(toNum(v)),
  'ceiling':          (v) => Math.ceil(toNum(v)),
  'abs':              (v) => Math.abs(toNum(v)),
  'pow':              (a, b) => toNum(a) ** toNum(b),
  'today':            () => localDate(new Date()),
  'now':              () => new Date().toISOString(),
  'date':             (v) => { const n = toNum(v); return Number.isNaN(n) ? '' : new Date(n * 86_400_000).toISOString().slice(0, 10) },
  'decimal-date-time': (v) => toNum(v),
  'once':             (v) => v,
  'uuid':             () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
}

function evaluate(ast, ctx) {
  switch (ast.k) {
    case 'lit':  return ast.v
    case 'ref':  return ctx.get(ast.name)
    case 'self': return ctx.self === undefined ? [] : [ctx.self]
    case 'neg':  return -toNum(evaluate(ast.a, ctx))
    case 'call': return ast.fn(...ast.args.map(a => evaluate(a, ctx)))
    case 'bin': {
      const { op } = ast
      if (op === 'or')  return toBool(evaluate(ast.a, ctx)) || toBool(evaluate(ast.b, ctx))
      if (op === 'and') return toBool(evaluate(ast.a, ctx)) && toBool(evaluate(ast.b, ctx))
      const a = evaluate(ast.a, ctx), b = evaluate(ast.b, ctx)
      if (['=', '!=', '<', '<=', '>', '>='].includes(op)) return compare(op, a, b)
      const x = toNum(a), y = toNum(b)
      return op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === 'div' ? x / y : x % y
    }
  }
}

// ── Form evaluation ───────────────────────────────────────────────────────────
const SCALAR = (v) => (Array.isArray(v) ? v.join(' ') : v == null ? '' : typeof v === 'object' ? '' : String(v))

/** Nest the flat XLSForm rows into a tree; returns { tree, defs: name → { row, repeats: [...enclosing repeat names] } }. */
export function buildTree(survey) {
  const root = { children: [] }, stack = [root], defs = {}, repeats = []
  for (const row of survey) {
    if (row.type === 'end_group' || row.type === 'end_repeat') {
      if (stack.length > 1) { const closed = stack.pop(); if (closed.row.type === 'begin_repeat') repeats.pop() }
      continue
    }
    const node = { row, children: [] }
    stack.at(-1).children.push(node)
    if (row.name) defs[row.name] = { row, repeats: [...repeats] }
    if (row.type.startsWith('begin_')) { stack.push(node); if (row.type === 'begin_repeat') repeats.push(row.name) }
  }
  return { tree: root.children, defs }
}

function makeGetter(defs, root, scope) {
  return (name) => {
    const def = defs[name]
    if (!def) return []
    let objs = [root]
    def.repeats.forEach((r, i) => { objs = scope[i]?.repeat === r ? [scope[i].data] : objs.flatMap(o => o?.[r] || []) })
    if (def.row.type === 'begin_repeat') return objs.flatMap(o => o?.[name] || []).map(() => '')
    if (def.row.type === 'begin_group') return ['']
    return objs.map(o => SCALAR(o?.[name]))
  }
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
const GEO_RE = /^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){0,2}$/

/** Coerces one answer to its stored JSON type; returns { value } or { error }. */
function coerce(row, raw, choices) {
  const s = typeof raw === 'string' ? raw.trim() : raw
  switch (row.type) {
    case 'integer': return /^-?\d+$/.test(String(s)) ? { value: Number(s) } : { error: 'Enter a whole number' }
    case 'decimal': return s !== '' && Number.isFinite(Number(s)) ? { value: Number(s) } : { error: 'Enter a number' }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? { value: s } : { error: 'Enter a valid date' }
    case 'time': return /^\d{2}:\d{2}(:\d{2})?$/.test(s) ? { value: s } : { error: 'Enter a valid time' }
    case 'datetime': return !Number.isNaN(Date.parse(s)) ? { value: String(s) } : { error: 'Enter a valid date and time' }
    case 'geopoint': {
      const [lat, lng] = String(s).split(/\s+/).map(Number)
      return GEO_RE.test(String(s)) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { value: String(s) } : { error: 'Invalid GPS location' }
    }
    case 'select_one': {
      const ok = (choices[row.list] || []).some(c => c.name === String(s))
      return ok ? { value: String(s) } : { error: 'Pick one of the options' }
    }
    case 'select_multiple': {
      const picked = Array.isArray(s) ? s.map(String) : String(s).split(' ').filter(Boolean)
      const allowed = new Set((choices[row.list] || []).map(c => c.name))
      return picked.every(p => allowed.has(p)) ? { value: [...new Set(picked)] } : { error: 'Pick from the options' }
    }
    default:
      if (typeof s === 'number') return { value: String(s) }
      return typeof s === 'string' ? (s.length <= 10_000 ? { value: s } : { error: 'Too long' }) : { error: 'Invalid value' }
  }
}

/**
 * Evaluates answers against a schema. Returns:
 *   data     — cleaned answers (non-relevant removed, calculates filled, types coerced)
 *   errors   — { [path]: message } (path like "age" or "member[1].m_name")
 *   relevant — { [path]: boolean } for every question/group, for the renderer
 *   repeatCounts — { [path]: n } for repeats with repeat_count
 * Archived rows are hidden and never validated; their stored values pass through untouched.
 */
export function evaluateForm(schema, input) {
  const { tree, defs } = buildTree(schema.survey || [])
  const choices = schema.choices || {}
  const data = structuredClone(input || {}) // calculates are written back into it between passes
  let result
  // Calculations can depend on later questions; settle by re-running (ODK uses a DAG).
  // ponytail: 3 passes covers chains of 3 calculates; build a dependency order if forms nest deeper.
  for (let pass = 0; pass < 3; pass++) {
    const errors = {}, relevant = {}, repeatCounts = {}
    const out = {}
    const walk = (nodes, src, dst, scope, prefix, parentOn) => {
      for (const { row, children } of nodes) {
        if (row.archived) { if (src && row.name in src) dst[row.name] = src[row.name]; continue }
        const path = prefix + row.name
        const ctx = { get: makeGetter(defs, data, scope) }
        let on = parentOn
        if (on && row.relevant) { try { on = toBool(evaluate(compile(row.relevant), ctx)) } catch { on = false } }
        relevant[path] = on
        if (row.type === 'begin_group') { walk(children, src, dst, scope, prefix, on); continue }
        if (row.type === 'begin_repeat') {
          let items = Array.isArray(src?.[row.name]) ? src[row.name] : []
          if (on && row.repeat_count) {
            let n = 0
            try { n = Math.max(0, Math.min(200, Math.trunc(toNum(evaluate(compile(row.repeat_count), ctx))) || 0)) } catch { /* 0 */ }
            repeatCounts[path] = n
            items = Array.from({ length: n }, (_, i) => items[i] || {})
            if (src) src[row.name] = items // keep instances so calculates inside them settle across passes
          }
          if (!on) continue
          dst[row.name] = items.map((item, i) => {
            const copy = {}
            walk(children, item, copy, [...scope, { repeat: row.name, data: item }], `${path}[${i}].`, true)
            return copy
          })
          continue
        }
        if (row.type === 'note' || !on) continue
        if (row.type === 'calculate') {
          let v = ''
          try { v = toStr(evaluate(compile(row.calculation), ctx)) } catch { /* empty */ }
          if (v === 'NaN') v = ''
          if (src) src[row.name] = v
          dst[row.name] = v
          continue
        }
        const raw = src?.[row.name]
        if (isEmpty(raw)) { if (row.required) errors[path] = 'Required'; continue }
        if (row.type === 'image' || row.type === 'audio') {
          if (typeof raw === 'string') dst[row.name] = raw; else errors[path] = 'Invalid file'
          continue
        }
        const c = coerce(row, raw, choices)
        if (c.error) { errors[path] = c.error; continue }
        dst[row.name] = c.value
        if (row.constraint) {
          let ok = false
          try { ok = toBool(evaluate(compile(row.constraint), { ...ctx, self: SCALAR(c.value) })) } catch { /* invalid → fails */ }
          if (!ok) errors[path] = row.constraint_message || 'This answer is not allowed'
        }
      }
    }
    walk(tree, data, out, [], '', true)
    result = { data: out, errors, relevant, repeatCounts }
  }
  return result
}
