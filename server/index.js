import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { MongoClient } from 'mongodb'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

dotenv.config({ path: '.env', override: true, quiet: true })

const app = express()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const port = Number(process.env.PORT || 8787)
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me'
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } })
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const memory = new Map()
const counters = new Map()
let database = null
let databasePromise = null

const collections = ['sales', 'inventory', 'work_notes', 'bill_history', 'auth_devices', 'app_settings', 'passbook_vendors']
for (const name of collections) memory.set(name, [])

async function connectDb() {
  if (database) return database
  if (databasePromise) return databasePromise
  if (!process.env.MONGO_URI) {
    if (process.env.VERCEL) throw new Error('MONGO_URI is not configured in Vercel Environment Variables.')
    return null
  }
  databasePromise = (async () => {
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    database = client.db(process.env.MONGO_DB || 'boutique_db')
    console.log(`MongoDB connected: ${database.databaseName}`)
    return database
  })().catch((error) => { databasePromise = null; throw error })
  return databasePromise
}

const clean = (value) => JSON.parse(JSON.stringify(value, (_key, val) =>
  val?.constructor?.name === 'ObjectId' ? String(val) : val,
))

async function list(name, query = {}) {
  if (database) return clean(await database.collection(name).find(query, { projection: { _id: 0 } }).toArray())
  return (memory.get(name) || []).filter((row) => Object.entries(query).every(([k, v]) => row[k] === v)).map(clean)
}
async function one(name, query) {
  if (database) return clean(await database.collection(name).findOne(query, { projection: { _id: 0 } }))
  return (memory.get(name) || []).find((row) => Object.entries(query).every(([k, v]) => row[k] === v)) || null
}
async function nextId(name) {
  if (database) {
    const result = await database.collection('counters').findOneAndUpdate(
      { _id: `${name}_id` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
    )
    return result.seq
  }
  const value = (counters.get(name) || 0) + 1
  counters.set(name, value)
  return value
}
async function insert(name, doc) {
  const row = clean(doc)
  if (database) await database.collection(name).insertOne(row)
  else memory.get(name).push(row)
  return row
}
async function update(name, query, patch) {
  if (database) return database.collection(name).updateOne(query, { $set: clean(patch) })
  const row = await one(name, query)
  if (row) Object.assign(row, clean(patch))
  return { modifiedCount: row ? 1 : 0 }
}
async function remove(name, query) {
  if (database) return database.collection(name).deleteOne(query)
  const rows = memory.get(name); const i = rows.findIndex((row) => Object.entries(query).every(([k, v]) => row[k] === v))
  if (i >= 0) rows.splice(i, 1)
  return { deletedCount: i >= 0 ? 1 : 0 }
}

function runPython(action, payload, timeoutMs = 90000) {
  if (process.env.VERCEL) {
    const deploymentHost = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL
    if (!deploymentHost) return Promise.reject(new Error('Vercel deployment URL is unavailable for the PDF service.'))
    return fetch(`https://${deploymentHost}/pdf-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': process.env.BRIDGE_SECRET || jwtSecret },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(data.error || 'Python PDF service failed.')
      return data.result
    })
  }
  const configured = process.env.PYTHON_BIN
  const venvPython = path.join(projectRoot, '.venv', 'bin', 'python')
  const python = configured || venvPython
  const script = path.join(__dirname, 'python_bridge.py')
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Python PDF operation timed out.')) }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`Could not start Python PDF service: ${error.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      let response
      try { response = JSON.parse(Buffer.concat(stdout).toString('utf8') || '{}') }
      catch { return reject(new Error(Buffer.concat(stderr).toString('utf8') || 'Python PDF service returned invalid output.')) }
      if (code !== 0 || !response.ok) return reject(new Error(response.error || Buffer.concat(stderr).toString('utf8') || 'Python PDF operation failed.'))
      resolve(response.result)
    })
    child.stdin.end(JSON.stringify({ action, payload }))
  })
}

app.use(async (_req, _res, next) => {
  if (!process.env.VERCEL) return next()
  try { await connectDb(); next() } catch (error) { next(error) }
})

function sign(user, role = 'admin') { return jwt.sign({ user, role }, jwtSecret, { expiresIn: '12h' }) }
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    req.user = jwt.verify(token, jwtSecret); next()
  } catch { res.status(401).json({ error: 'Please sign in again.' }) }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: database ? 'mongodb' : 'memory' }))
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '')
  const password = String(req.body.password || '')
  const expectedUser = process.env.USERNAME || 'admin'
  const validPassword = process.env.PASSWORD_HASH
    ? await bcrypt.compare(password, process.env.PASSWORD_HASH)
    : password === (process.env.PASSWORD || 'admin')
  if (username !== expectedUser || !validPassword) return res.status(401).json({ error: 'Invalid username or password.' })
  const device = { id: crypto.randomUUID(), username, role: 'admin', active: true, login_method: 'password', last_login_at: new Date().toISOString(), user_agent: req.headers['user-agent'] || '' }
  // Device history is useful, but it must never leave a valid login spinning
  // forever if MongoDB temporarily cannot write this non-critical audit row.
  try {
    await Promise.race([
      insert('auth_devices', device),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Device audit write timed out')), 5000)),
    ])
  } catch (error) {
    console.warn(`Login audit was not saved: ${error.message}`)
  }
  res.json({ token: sign(username), user: { username, role: 'admin' }, deviceId: device.id })
})
app.get('/api/auth/me', auth, (req, res) => res.json(req.user))

function saleFromBody(body) {
  const selling = Number(body.selling_price || 0), buying = Number(body.buying_price || 0), paid = Number(body.amount_paid || 0)
  return {
    customer_name: String(body.customer_name || '').trim(), customer_phone: String(body.customer_phone || '').trim(),
    sale_date: body.sale_date || new Date().toISOString().slice(0, 10), vendor: String(body.vendor || '').trim(),
    product_category: body.product_category || 'Other', product_description: String(body.product_description || '').trim(),
    buying_price: buying, selling_price: selling, amount_paid: Math.min(paid, selling), pending_amount: Math.max(0, selling - paid),
    payment_received: paid >= selling ? 1 : 0, delay_status: body.delay_status ? 1 : 0,
    payment_method: body.payment_method || 'UPI', notes: String(body.notes || '').trim(),
    quantity: Math.max(1, Number(body.quantity || 1)),
    ...(body.passbook_source ? { passbook_source: clean(body.passbook_source) } : {}),
  }
}
app.post('/api/public/sales', async (req, res, next) => { try {
  const row = saleFromBody(req.body)
  if (!row.customer_name || row.selling_price <= 0) return res.status(400).json({ error: 'Customer name and a valid selling price are required.' })
  row.id = await nextId('sales'); row.created_at = new Date().toISOString(); row.source = 'public'
  await insert('sales', row); res.status(201).json(row)
} catch (e) { next(e) } })

app.get('/api/sales', auth, async (_req, res, next) => { try {
  const rows = await list('sales'); rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date))); res.json(rows)
} catch (e) { next(e) } })
app.post('/api/sales', auth, async (req, res, next) => { try {
  const row = saleFromBody(req.body)
  if (!row.customer_name || row.selling_price <= 0) return res.status(400).json({ error: 'Customer name and a valid selling price are required.' })
  row.id = await nextId('sales'); row.created_at = new Date().toISOString(); row.created_by = req.user.user
  await insert('sales', row); res.status(201).json(row)
} catch (e) { next(e) } })
app.put('/api/sales/:id', auth, async (req, res, next) => { try {
  const id = Number(req.params.id), current = await one('sales', { id })
  if (!current) return res.status(404).json({ error: 'Transaction not found.' })
  const patch = saleFromBody({ ...current, ...req.body }); patch.updated_at = new Date().toISOString(); patch.updated_by = req.user.user
  await update('sales', { id }, patch); res.json({ ...current, ...patch })
} catch (e) { next(e) } })
app.delete('/api/sales/:id', auth, async (req, res, next) => { try { await remove('sales', { id: Number(req.params.id) }); res.status(204).end() } catch (e) { next(e) } })
app.post('/api/sales/:id/payment', auth, async (req, res, next) => { try {
  const id = Number(req.params.id), row = await one('sales', { id })
  if (!row) return res.status(404).json({ error: 'Transaction not found.' })
  const amount = Math.max(0, Math.min(Number(req.body.amount || 0), Number(row.pending_amount || 0)))
  if (!amount) return res.status(400).json({ error: 'Enter a valid collection amount.' })
  const paid = Number(row.amount_paid || 0) + amount, pending = Math.max(0, Number(row.selling_price || 0) - paid)
  const patch = { amount_paid: paid, pending_amount: pending, payment_received: pending <= 0 ? 1 : 0, last_payment_date: req.body.date || new Date().toISOString().slice(0, 10), last_payment_method: req.body.method || 'UPI', last_payment_received_by: req.body.received_by || req.user.user, updated_at: new Date().toISOString() }
  await update('sales', { id }, patch); res.json({ ...row, ...patch })
} catch (e) { next(e) } })

app.get('/api/inventory', auth, async (_req, res, next) => { try { res.json(await list('inventory')) } catch (e) { next(e) } })
app.post('/api/inventory', auth, async (req, res, next) => { try {
  const id = Number(req.body.id || 0), existing = id ? await one('inventory', { id }) : null
  const row = { id: existing?.id || await nextId('inventory'), item: String(req.body.item || '').trim(), vendor: String(req.body.vendor || '').trim(), category: req.body.category || 'Other', quantity: Number(req.body.quantity || 0), reorder_level: Number(req.body.reorder_level || 0), cost_price: Number(req.body.cost_price || 0), selling_price: Number(req.body.selling_price || 0), updated_at: new Date().toISOString() }
  if (!row.item) return res.status(400).json({ error: 'Item name is required.' })
  existing ? await update('inventory', { id }, row) : await insert('inventory', row); res.json(row)
} catch (e) { next(e) } })
app.delete('/api/inventory/:id', auth, async (req, res, next) => { try { await remove('inventory', { id: Number(req.params.id) }); res.status(204).end() } catch (e) { next(e) } })

app.get('/api/notes', auth, async (_req, res, next) => { try { const rows = await list('work_notes'); rows.sort((a,b) => String(b.work_date).localeCompare(String(a.work_date))); res.json(rows) } catch (e) { next(e) } })
app.post('/api/notes', auth, async (req, res, next) => { try { const row = { id: await nextId('work_notes'), work_date: req.body.work_date, note: String(req.body.note || '').trim(), created_at: new Date().toISOString(), created_by: req.user.user }; if (!row.note) return res.status(400).json({ error: 'Note cannot be empty.' }); await insert('work_notes', row); res.json(row) } catch (e) { next(e) } })
app.delete('/api/notes/:id', auth, async (req, res, next) => { try { await remove('work_notes', { id: Number(req.params.id) }); res.status(204).end() } catch (e) { next(e) } })

app.get('/api/bills', auth, async (_req, res, next) => { try { res.json(await list('bill_history')) } catch (e) { next(e) } })
app.post('/api/bills', auth, async (req, res, next) => { try { const row = { ...req.body, bill_id: `SKB-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(await nextId('bills')).padStart(4,'0')}`, generated_at: new Date().toISOString(), generated_by: req.user.user }; await insert('bill_history', row); res.json(row) } catch (e) { next(e) } })
app.post('/api/bills/generate', auth, async (req, res, next) => { try {
  const customerName = String(req.body.customer_name || '').trim()
  const scope = ['All Transactions', 'Last Transactions', 'Pending Transactions'].includes(req.body.bill_scope) ? req.body.bill_scope : 'All Transactions'
  const limit = Math.max(1, Math.min(Number(req.body.bill_limit || 5), 100))
  const billDate = String(req.body.bill_date || new Date().toISOString().slice(0, 10))
  let rows = (await list('sales')).filter((row) => String(row.customer_name || '').toLocaleLowerCase() === customerName.toLocaleLowerCase())
  if (scope === 'Pending Transactions') rows = rows.filter((row) => Number(row.pending_amount || 0) > 0)
  if (scope === 'Last Transactions') rows = rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)) || Number(b.id) - Number(a.id)).slice(0, limit)
  rows.sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)) || Number(a.id) - Number(b.id))
  if (!rows.length) return res.status(400).json({ error: scope === 'Pending Transactions' ? 'No pending transactions found for this customer.' : 'No purchases found for this customer.' })
  const dayKey = billDate.replaceAll('-', '')
  const billId = `SKB-${dayKey}-${String(await nextId(`bill_${dayKey}`)).padStart(4, '0')}`
  const scopeLabel = scope === 'Last Transactions' ? `Last ${limit} Transactions` : scope
  const generated = await runPython('generate_bill', { sales: rows, customer_name: customerName, bill_id: billId, bill_date: billDate, bill_scope_label: scopeLabel })
  const history = {
    bill_id: billId, bill_date: billDate, customer_name: customerName, customer_phone: generated.customer_phone,
    bill_scope: scope, bill_limit: scope === 'Last Transactions' ? limit : null, bill_scope_label: scopeLabel,
    purchase_count: rows.length, purchase_ids: rows.map((row) => Number(row.id)),
    items: rows.map((row) => ({ sale_id: Number(row.id), sale_date: row.sale_date, category: row.product_category || '', description: row.product_description || '', bill_amount: Number(row.selling_price || 0), paid_amount: Number(row.amount_paid || 0), pending_amount: Number(row.pending_amount || 0), paid_date: row.last_payment_date || row.payment_date || '-', status: Number(row.pending_amount || 0) <= 0 ? 'PAID [x]' : 'PENDING' })),
    total_bill: generated.total_bill, total_paid: generated.total_paid, total_pending: generated.total_pending,
    upi_id: '9176619942@ybl', generated_at: new Date().toISOString(), generated_by: req.user.user,
  }
  await insert('bill_history', history)
  const pdfBytes = Buffer.from(generated.pdf_base64, 'base64')
  const safeName = customerName.replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'customer'
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${billId.toLowerCase()}_bill_${safeName}_${billDate}.pdf"`)
  res.setHeader('X-Bill-ID', billId)
  res.setHeader('Access-Control-Expose-Headers', 'X-Bill-ID, Content-Disposition')
  res.send(pdfBytes)
} catch (e) { next(e) } })

app.get('/api/devices', auth, async (_req, res, next) => { try { res.json(await list('auth_devices')) } catch (e) { next(e) } })
app.patch('/api/devices/:id', auth, async (req, res, next) => { try { await update('auth_devices', { id: req.params.id }, { active: Boolean(req.body.active), updated_at: new Date().toISOString() }); res.json({ ok: true }) } catch (e) { next(e) } })

app.get('/api/settings', auth, async (_req, res, next) => { try { res.json((await one('app_settings', { id: 'global' })) || {}) } catch (e) { next(e) } })
app.put('/api/settings', auth, async (req, res, next) => { try { const old = await one('app_settings', { id: 'global' }); const row = { ...old, ...req.body, id: 'global', updated_at: new Date().toISOString(), updated_by: req.user.user }; old ? await update('app_settings', { id: 'global' }, row) : await insert('app_settings', row); res.json(row) } catch (e) { next(e) } })

app.get('/api/backup', auth, async (_req, res, next) => { try { const data = {}; for (const name of collections) data[name] = await list(name); res.setHeader('Content-Disposition', `attachment; filename="boutique-backup-${new Date().toISOString().slice(0,10)}.json"`); res.json({ version: 3, created_at: new Date().toISOString(), data }) } catch (e) { next(e) } })
app.post('/api/restore', auth, async (req, res, next) => { try { const data = req.body.data || {}; let inserted = 0; for (const name of collections) for (const row of (data[name] || [])) { await insert(name, row); inserted++ } res.json({ inserted }) } catch (e) { next(e) } })

app.post('/api/passbook/parse', auth, upload.array('files', 10), async (req, res, next) => { try {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose one or more PDF files.' })
  const files = req.files.map((file) => ({ filename: file.originalname, base64: file.buffer.toString('base64') }))
  res.json(await runPython('parse_passbooks', { files }))
} catch (e) { next(e) } })
app.get('/api/passbook/vendors', auth, async (_req, res, next) => { try {
  const rows = await list('passbook_vendors'); res.json(rows.map((row) => row.name).filter(Boolean).sort((a, b) => a.localeCompare(b)))
} catch (e) { next(e) } })
app.post('/api/passbook/vendors', auth, async (req, res, next) => { try {
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim(), key = name.toLocaleLowerCase()
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' })
  const existing = await one('passbook_vendors', { key })
  const row = { key, name, updated_at: new Date().toISOString(), updated_by: req.user.user }
  existing ? await update('passbook_vendors', { key }, row) : await insert('passbook_vendors', { ...row, created_at: new Date().toISOString() })
  res.json(row)
} catch (e) { next(e) } })
app.delete('/api/passbook/vendors/:name', auth, async (req, res, next) => { try {
  await remove('passbook_vendors', { key: decodeURIComponent(req.params.name).toLocaleLowerCase() }); res.status(204).end()
} catch (e) { next(e) } })

async function askAI(question, context) {
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase()
  if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: `You are a concise boutique business assistant.\n\nCONTEXT:\n${context}\n\nTASK:\n${question}` }] }] }) })
    const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || 'Gemini request failed')
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || 'No response.'
  }
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: 'You are a concise boutique business assistant.' }, { role: 'user', content: `CONTEXT:\n${context}\n\nTASK:\n${question}` }] }) })
    const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || 'OpenAI request failed')
    return json.choices?.[0]?.message?.content || 'No response.'
  }
  throw new Error('Configure GEMINI_API_KEY or OPENAI_API_KEY on the server.')
}
app.post('/api/ai', auth, async (req, res, next) => { try {
  const sales = (await list('sales')).slice(-150), inventory = (await list('inventory')).slice(-100), notes = (await list('work_notes')).slice(-30)
  const context = JSON.stringify({ sales, inventory, notes }).slice(0, 80000)
  res.json({ answer: await askAI(String(req.body.question || ''), context) })
} catch (e) { next(e) } })

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message || 'Unexpected server error.' }) })

const dist = path.resolve(__dirname, '../dist')
app.use(express.static(dist))
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(dist, 'index.html'))
  next()
})

if (!process.env.VERCEL) {
  connectDb().catch((error) => console.warn(`MongoDB unavailable; using in-memory storage: ${error.message}`)).finally(() => app.listen(port, () => console.log(`Boutique API listening on http://localhost:${port}`)))
}

export default app
