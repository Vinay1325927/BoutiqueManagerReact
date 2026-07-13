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
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto'

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

const collections = ['sales', 'work_notes', 'bill_history', 'auth_devices', 'app_settings', 'passbook_vendors', 'iam_users', 'signup_requests', 'auth_challenges', 'oauth_states', 'oauth_tickets']
const backupCollections = collections.filter((name) => !['auth_challenges', 'oauth_states', 'oauth_tickets'].includes(name))
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

async function consumeChallenge(id, key) {
  const usedAt = now()
  if (database) {
    const row = await database.collection('auth_challenges').findOneAndUpdate(
      { id, username_key: key, used: false, expires_at: { $gt: usedAt } },
      { $set: { used: true, used_at: usedAt } },
      { returnDocument: 'before', projection: { _id: 0 } },
    )
    return clean(row)
  }
  const row = await one('auth_challenges', { id })
  if (!row || row.username_key !== key || row.used || row.expires_at <= usedAt) return null
  row.used = true; row.used_at = usedAt
  return clean(row)
}

async function consumeTransient(name, id, match = {}) {
  const usedAt = now()
  if (database) {
    const row = await database.collection(name).findOneAndUpdate(
      { id, used: false, expires_at: { $gt: usedAt }, ...match },
      { $set: { used: true, used_at: usedAt } },
      { returnDocument: 'before', projection: { _id: 0 } },
    )
    return clean(row)
  }
  const row = await one(name, { id })
  if (!row || row.used || row.expires_at <= usedAt || Object.entries(match).some(([key, value]) => row[key] !== value)) return null
  row.used = true; row.used_at = usedAt
  return clean(row)
}

const FEATURE_IDS = ['dashboard', 'add-sale', 'review', 'update', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'passbook', 'notes', 'ai', 'technical', 'backup']
const CUSTOM_FEATURE_IDS = FEATURE_IDS.filter((id) => id !== 'backup')
const VIEWER_FEATURES = ['dashboard', 'review', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'notes', 'ai']
const usernameKey = (value) => String(value || '').trim().toLocaleLowerCase()
const now = () => new Date().toISOString()

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: row.role === 'admin' ? FEATURE_IDS : row.role === 'viewer' ? VIEWER_FEATURES : (row.permissions || []).filter((id) => CUSTOM_FEATURE_IDS.includes(id)),
    active: row.active !== false,
    source: row.source || 'managed',
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
    profile: row.profile || {},
    pem: {
      enabled: Boolean(row.pem_public_key),
      fingerprint: row.pem_fingerprint || '',
      filename: row.pem_filename || '',
      enrolled_at: row.pem_enrolled_at || '',
    },
  }
}

function publicSignupRequest(row) {
  if (!row) return null
  const { password_hash: _passwordHash, ...safe } = row
  return safe
}

async function ensureEnvironmentAdmin() {
  const username = String(process.env.USERNAME || 'admin').trim()
  const key = usernameKey(username)
  const existing = await one('iam_users', { username_key: key })
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLocaleLowerCase()
  const profile = adminEmail ? { ...(existing?.profile || {}), email: adminEmail, email_key: adminEmail } : (existing?.profile || {})
  const patch = { username, username_key: key, role: 'admin', permissions: FEATURE_IDS, active: true, source: 'environment', profile, updated_at: now() }
  if (existing) {
    await update('iam_users', { id: existing.id }, patch)
    return { ...existing, ...patch }
  }
  const row = { id: randomUUID(), ...patch, created_at: now(), created_by: 'environment' }
  await insert('iam_users', row)
  return row
}

function requestOrigin(req) {
  const configured = String(process.env.OAUTH_REDIRECT_BASE || '').replace(/\/$/, '')
  if (configured) return configured
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim()
  return `${protocol}://${req.get('host')}`
}

function oauthSettings(provider, req) {
  const redirectUri = `${requestOrigin(req)}/api/auth/oauth/${provider}/callback`
  if (provider === 'google') return {
    provider, label: 'Google', clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile',
  }
  if (provider === 'microsoft') {
    const tenant = encodeURIComponent(process.env.MICROSOFT_TENANT_ID || 'common')
    return {
      provider, label: 'Microsoft', clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      redirectUri, authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userInfoUrl: 'https://graph.microsoft.com/oidc/userinfo', scope: 'openid profile email',
    }
  }
  return null
}

function landingRedirect(req, key, value) {
  const url = new URL(requestOrigin(req))
  url.searchParams.set(key, value)
  return url.toString()
}

async function exchangeOAuthCode(settings, code) {
  if (!code) throw new Error(`${settings.label} did not return an authorization code.`)
  const tokenResponse = await fetch(settings.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, code, grant_type: 'authorization_code', redirect_uri: settings.redirectUri }),
  })
  const token = await tokenResponse.json().catch(() => ({}))
  if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || token.error || `${settings.label} token exchange failed.`)
  const profileResponse = await fetch(settings.userInfoUrl, { headers: { Authorization: `Bearer ${token.access_token}` } })
  const profile = await profileResponse.json().catch(() => ({}))
  if (!profileResponse.ok) throw new Error(profile.error?.message || profile.error_description || `${settings.label} profile request failed.`)
  const email = String(profile.email || profile.preferred_username || '').trim().toLocaleLowerCase()
  if (!email || !email.includes('@')) throw new Error(`${settings.label} did not provide a usable email address.`)
  if (settings.provider === 'google' && profile.email_verified === false) throw new Error('The Google email address is not verified.')
  const subject = String(profile.sub || '').trim()
  if (!subject) throw new Error(`${settings.label} did not return a stable account identifier.`)
  return { provider: settings.provider, subject, email, name: String(profile.name || '').trim(), picture: String(profile.picture || '') }
}

async function findIamUserForOAuth(identity) {
  const users = await list('iam_users')
  return users.find((user) => (user.auth_providers || []).some((provider) => provider.provider === identity.provider && provider.subject === identity.subject))
    || users.find((user) => usernameKey(user.profile?.email || user.profile?.email_key) === identity.email)
}

function readableError(value, fallback = 'Unexpected server error.') {
  if (!value) return fallback
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message || fallback
  if (typeof value === 'object') {
    const nested = value.error && typeof value.error === 'object' ? value.error : value
    if (nested.message) return nested.code ? `${nested.code}: ${nested.message}` : nested.message
    try { return JSON.stringify(value) } catch { return fallback }
  }
  return String(value)
}

function runPython(action, payload, timeoutMs = 90000, requestContext = {}) {
  if (process.env.VERCEL) {
    const deploymentHost = requestContext.host || process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL
    if (!deploymentHost) return Promise.reject(new Error('Vercel deployment URL is unavailable for the PDF service.'))
    const bridgeHeaders = {
      'Content-Type': 'application/json',
      'X-Bridge-Secret': process.env.BRIDGE_SECRET || jwtSecret,
    }
    // The PDF function is another function in this protected deployment.
    // Forward the caller's Vercel session or automation bypass so the
    // server-to-server request is not redirected to the SSO page.
    const bypass = requestContext.protectionBypass || process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    if (bypass) bridgeHeaders['x-vercel-protection-bypass'] = bypass
    if (requestContext.cookie) bridgeHeaders.cookie = requestContext.cookie
    return fetch(`https://${deploymentHost}/pdf-service`, {
      method: 'POST',
      headers: bridgeHeaders,
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) throw new Error(readableError(data.error || data, 'Python PDF service failed.'))
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

function pythonRequestContext(req) {
  return {
    host: req.get('host'),
    cookie: req.headers.cookie || '',
    protectionBypass: req.headers['x-vercel-protection-bypass'] || '',
  }
}

app.use(async (_req, _res, next) => {
  if (!process.env.VERCEL) return next()
  try { await connectDb(); next() } catch (error) { next(error) }
})

function sign(user, deviceId) {
  return jwt.sign({ user: user.username, user_id: user.id, role: user.role, permissions: publicUser(user).permissions, device_id: deviceId }, jwtSecret, { expiresIn: '12h' })
}

async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const payload = jwt.verify(token, jwtSecret)
    let user
    if (payload.user_id) user = await one('iam_users', { id: payload.user_id })
    else if (payload.role === 'admin' && usernameKey(payload.user) === usernameKey(process.env.USERNAME || 'admin')) user = await ensureEnvironmentAdmin()
    if (!user || user.active === false) return res.status(401).json({ error: 'This account is inactive or no longer exists.' })
    if (payload.device_id) {
      const device = await one('auth_devices', { id: payload.device_id })
      if (device && device.active === false) return res.status(401).json({ error: 'This device session was revoked.' })
    }
    req.user = { user: user.username, username: user.username, user_id: user.id, role: user.role, permissions: publicUser(user).permissions, device_id: payload.device_id }
    next()
  } catch { res.status(401).json({ error: 'Please sign in again.' }) }
}

function canAccess(user, feature, write = false) {
  if (user.role === 'admin') return true
  if (user.role === 'viewer') return !write && VIEWER_FEATURES.includes(feature)
  return user.role === 'custom' && (user.permissions || []).includes(feature)
}

function permit(feature, { write = false, adminOnly = false } = {}) {
  return (req, res, next) => {
    if (adminOnly && req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' })
    if (!adminOnly && !canAccess(req.user, feature, write)) return res.status(403).json({ error: write ? 'You do not have permission to change this feature.' : 'You do not have access to this feature.' })
    next()
  }
}

function permitAny(features, { write = false } = {}) {
  return (req, res, next) => {
    if (!features.some((feature) => canAccess(req.user, feature, write))) return res.status(403).json({ error: 'You do not have permission to perform this action.' })
    next()
  }
}

async function recordLogin(req, user, method) {
  const device = { id: randomUUID(), username: user.username, user_id: user.id, role: user.role, active: true, login_method: method, last_login_at: now(), user_agent: req.headers['user-agent'] || '' }
  try {
    await Promise.race([
      insert('auth_devices', device),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Device audit write timed out')), 5000)),
    ])
  } catch (error) {
    console.warn(`Login audit was not saved: ${error.message}`)
  }
  await update('iam_users', { id: user.id }, { last_login_at: device.last_login_at })
  return device
}

app.get('/api/health', (_req, res) => res.json({ ok: true, database: database ? 'mongodb' : 'memory' }))
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim()
  const password = String(req.body.password || '')
  const expectedUser = process.env.USERNAME || 'admin'
  let user = await one('iam_users', { username_key: usernameKey(username) })
  let validPassword = false
  if (usernameKey(username) === usernameKey(expectedUser)) {
    validPassword = process.env.PASSWORD_HASH
      ? await bcrypt.compare(password, process.env.PASSWORD_HASH)
      : password === (process.env.PASSWORD || 'admin')
    if (validPassword) user = await ensureEnvironmentAdmin()
  } else if (user?.password_hash) validPassword = await bcrypt.compare(password, user.password_hash)
  if (!user || user.active === false || !validPassword) return res.status(401).json({ error: 'Invalid username or password.' })
  const device = await recordLogin(req, user, 'password')
  res.json({ token: sign(user, device.id), user: publicUser(user), deviceId: device.id })
})

function signupInput(body, passwordRequired) {
  const data = {
    full_name: String(body.full_name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    email: String(body.email || '').trim().toLocaleLowerCase().slice(0, 180),
    phone: String(body.phone || '').trim().slice(0, 40),
    organization_name: String(body.organization_name || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    organization_type: String(body.organization_type || '').trim().slice(0, 100),
    job_title: String(body.job_title || '').trim().slice(0, 100),
    team_size: String(body.team_size || '').trim().slice(0, 30),
    website: String(body.website || '').trim().slice(0, 250),
    city: String(body.city || '').trim().slice(0, 100), state: String(body.state || '').trim().slice(0, 100), country: String(body.country || '').trim().slice(0, 100),
    requested_username: String(body.requested_username || '').trim(), use_case: String(body.use_case || '').trim().slice(0, 1500), how_heard: String(body.how_heard || '').trim().slice(0, 200),
  }
  const password = String(body.password || ''), confirmPassword = String(body.confirm_password || '')
  if (!data.full_name || !data.organization_name || !data.organization_type || !data.city || !data.state || !data.country) return { error: 'Complete all required contact and organisation details.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return { error: 'Enter a valid business email address.' }
  const phoneDigits = data.phone.replace(/\D/g, '')
  if (phoneDigits.length < 7 || phoneDigits.length > 16) return { error: 'Enter a valid phone number.' }
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(data.requested_username)) return { error: 'Username must be 3–50 characters and use only letters, numbers, dots, dashes or underscores.' }
  if (body.terms !== true) return { error: 'Confirm the registration information and access terms.' }
  if (passwordRequired && (password.length < 8 || password !== confirmPassword)) return { error: password !== confirmPassword ? 'Passwords do not match.' : 'Use a password with at least 8 characters.' }
  return { data: { ...data, email_key: data.email, username_key: usernameKey(data.requested_username) }, password }
}

async function createSignupRequest(req, mode) {
  const parsed = signupInput(req.body, mode === 'password')
  if (parsed.error) return { error: parsed.error }
  const { data, password } = parsed
  const users = await list('iam_users')
  if (users.some((user) => user.username_key === data.username_key)) return { error: 'That username already belongs to an IAM account.' }
  if (users.some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === data.email_key)) return { error: 'An IAM account already exists for this email. Please log in instead.' }
  const requests = await list('signup_requests')
  const existingOAuth = mode === 'oauth' && requests.find((row) => row.status === 'oauth_pending' && row.username_key === data.username_key && row.email_key === data.email_key)
  if (existingOAuth) {
    const patch = { ...data, updated_at: now(), user_agent: req.headers['user-agent'] || existingOAuth.user_agent || '' }
    await update('signup_requests', { id: existingOAuth.id }, patch)
    return { row: { ...existingOAuth, ...patch } }
  }
  if (requests.some((row) => ['pending', 'oauth_pending'].includes(row.status) && (row.username_key === data.username_key || row.email_key === data.email_key))) return { error: 'A registration request already exists for this email or username.' }
  const row = {
    id: randomUUID(), ...data, signup_method: mode, status: mode === 'password' ? 'pending' : 'oauth_pending', terms_accepted: true,
    password_hash: mode === 'password' ? await bcrypt.hash(password, 12) : '', created_at: now(), updated_at: now(), user_agent: req.headers['user-agent'] || '',
  }
  await insert('signup_requests', row)
  return { row }
}

app.post('/api/auth/signup', async (req, res, next) => { try {
  const result = await createSignupRequest(req, 'password')
  if (result.error) return res.status(400).json({ error: result.error })
  res.status(201).json({ ok: true, request_id: result.row.id, message: 'Registration submitted for administrator approval.' })
} catch (e) { next(e) } })
app.post('/api/auth/signup/oauth/prepare', async (req, res, next) => { try {
  const result = await createSignupRequest(req, 'oauth')
  if (result.error) return res.status(400).json({ error: result.error })
  res.status(201).json({ ok: true, request_id: result.row.id })
} catch (e) { next(e) } })

app.get('/api/auth/oauth/:provider/start', async (req, res, next) => { try {
  const settings = oauthSettings(req.params.provider, req), intent = req.query.intent === 'signup' ? 'signup' : 'login'
  if (!settings) return res.redirect(landingRedirect(req, 'oauth_error', 'Unsupported sign-in provider.'))
  if (!settings.clientId || !settings.clientSecret) return res.redirect(landingRedirect(req, 'oauth_error', `${settings.label} sign-in is not configured yet.`))
  const requestId = String(req.query.request_id || '')
  if (intent === 'signup') {
    const signup = await one('signup_requests', { id: requestId })
    if (!signup || signup.status !== 'oauth_pending') return res.redirect(landingRedirect(req, 'oauth_error', 'The social signup request is missing or expired.'))
  }
  const state = { id: randomUUID(), provider: settings.provider, intent, signup_request_id: requestId, used: false, created_at: now(), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  await insert('oauth_states', state)
  const url = new URL(settings.authorizeUrl)
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code', scope: settings.scope, state: state.id, prompt: 'select_account' }).toString()
  res.redirect(url.toString())
} catch (e) { next(e) } })

app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
  const settings = oauthSettings(req.params.provider, req)
  try {
    if (!settings) throw new Error('Unsupported sign-in provider.')
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error))
    const state = await consumeTransient('oauth_states', String(req.query.state || ''), { provider: settings.provider })
    if (!state) throw new Error('The sign-in request is invalid or expired.')
    const identity = await exchangeOAuthCode(settings, String(req.query.code || ''))
    let user = await findIamUserForOAuth(identity)
    if (state.intent === 'signup') {
      if (user) throw new Error('An approved account already exists for this email. Please log in instead.')
      const signup = await one('signup_requests', { id: state.signup_request_id })
      if (!signup || signup.status !== 'oauth_pending') throw new Error('The signup request is no longer available.')
      const duplicates = await list('signup_requests')
      if (duplicates.some((row) => row.id !== signup.id && ['pending', 'oauth_pending'].includes(row.status) && row.email_key === identity.email)) throw new Error('An open request already exists for this verified email.')
      const patch = { email: identity.email, email_key: identity.email, full_name: signup.full_name || identity.name, oauth_provider: identity.provider, oauth_subject: identity.subject, oauth_picture: identity.picture, status: 'pending', verified_at: now(), updated_at: now() }
      await update('signup_requests', { id: signup.id }, patch)
      return res.redirect(landingRedirect(req, 'signup_status', 'pending'))
    }
    if (!user || user.active === false) throw new Error('No active IAM account matches this verified email. Submit a signup request first.')
    if (!(user.auth_providers || []).some((provider) => provider.provider === identity.provider && provider.subject === identity.subject)) {
      const authProviders = [...(user.auth_providers || []).filter((provider) => provider.provider !== identity.provider), { provider: identity.provider, subject: identity.subject, email: identity.email, linked_at: now() }]
      const profile = { ...(user.profile || {}), email: identity.email, email_key: identity.email, full_name: user.profile?.full_name || identity.name, picture: identity.picture || user.profile?.picture || '' }
      await update('iam_users', { id: user.id }, { auth_providers: authProviders, profile, updated_at: now() })
      user = { ...user, auth_providers: authProviders, profile }
    }
    const device = await recordLogin(req, user, identity.provider)
    const ticket = { id: randomUUID(), user_id: user.id, device_id: device.id, used: false, created_at: now(), expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
    await insert('oauth_tickets', ticket)
    res.redirect(landingRedirect(req, 'oauth_ticket', ticket.id))
  } catch (error) { res.redirect(landingRedirect(req, 'oauth_error', readableError(error, 'Social sign-in failed.'))) }
})

app.post('/api/auth/oauth/exchange', async (req, res, next) => { try {
  const ticket = await consumeTransient('oauth_tickets', String(req.body.ticket || ''))
  if (!ticket) return res.status(401).json({ error: 'The social sign-in ticket is invalid or expired.' })
  const user = await one('iam_users', { id: ticket.user_id })
  if (!user || user.active === false) return res.status(401).json({ error: 'This IAM account is not active.' })
  res.json({ token: sign(user, ticket.device_id), user: publicUser(user), deviceId: ticket.device_id })
} catch (e) { next(e) } })

app.post('/api/auth/pem/challenge', async (req, res, next) => { try {
  const key = usernameKey(req.body.username)
  const user = await one('iam_users', { username_key: key })
  if (!user || user.active === false || !user.pem_public_key) return res.status(401).json({ error: 'PEM sign-in is not configured for this account.' })
  const row = { id: randomUUID(), username_key: key, challenge: randomBytes(32).toString('base64'), created_at: now(), expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), used: false }
  await insert('auth_challenges', row)
  res.json({ challenge_id: row.id, challenge: row.challenge, expires_at: row.expires_at })
} catch (e) { next(e) } })
app.post('/api/auth/pem/login', async (req, res, next) => { try {
  const key = usernameKey(req.body.username), challengeId = String(req.body.challenge_id || ''), signature = String(req.body.signature || '')
  const user = await one('iam_users', { username_key: key })
  const challenge = await consumeChallenge(challengeId, key)
  if (!user || user.active === false || !user.pem_public_key || !challenge) return res.status(401).json({ error: 'The PEM challenge is invalid or expired. Please try again.' })
  let valid = false
  try { valid = verifySignature('sha256', Buffer.from(challenge.challenge, 'base64'), user.pem_public_key, Buffer.from(signature, 'base64')) } catch { valid = false }
  if (!valid) return res.status(401).json({ error: 'The PEM file does not match this account.' })
  const device = await recordLogin(req, user, 'pem')
  res.json({ token: sign(user, device.id), user: publicUser(user), deviceId: device.id })
} catch (e) { next(e) } })
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await one('iam_users', { id: req.user.user_id })
  res.json(publicUser(user))
})

app.get('/api/iam/signup-requests', auth, permit('iam', { adminOnly: true }), async (_req, res, next) => { try {
  const rows = await list('signup_requests')
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  res.json(rows.map(publicSignupRequest))
} catch (e) { next(e) } })
app.post('/api/iam/signup-requests/:id/approve', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const signup = await one('signup_requests', { id: req.params.id })
  if (!signup || signup.status !== 'pending') return res.status(404).json({ error: 'Pending signup request not found.' })
  if (await one('iam_users', { username_key: signup.username_key })) return res.status(409).json({ error: 'That username already belongs to an IAM user.' })
  if ((await list('iam_users')).some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === signup.email_key)) return res.status(409).json({ error: 'That email already belongs to an IAM user.' })
  if (signup.signup_method === 'password' && !signup.password_hash) return res.status(400).json({ error: 'This password registration no longer has valid credentials.' })
  if (signup.signup_method === 'oauth' && (!signup.oauth_provider || !signup.oauth_subject)) return res.status(400).json({ error: 'Social signup verification is incomplete.' })
  const profile = {
    full_name: signup.full_name, email: signup.email, email_key: signup.email_key, phone: signup.phone, organization_name: signup.organization_name,
    organization_type: signup.organization_type, job_title: signup.job_title, team_size: signup.team_size, website: signup.website,
    city: signup.city, state: signup.state, country: signup.country, use_case: signup.use_case, how_heard: signup.how_heard, picture: signup.oauth_picture || '',
  }
  const row = {
    id: randomUUID(), username: signup.requested_username, username_key: signup.username_key, role: 'viewer', permissions: VIEWER_FEATURES, active: true,
    source: 'signup', password_hash: signup.password_hash || '', profile, signup_request_id: signup.id,
    auth_providers: signup.oauth_provider ? [{ provider: signup.oauth_provider, subject: signup.oauth_subject, email: signup.email, linked_at: now() }] : [],
    created_at: now(), created_by: req.user.user, updated_at: now(),
  }
  await insert('iam_users', row)
  await update('signup_requests', { id: signup.id }, { status: 'approved', password_hash: '', approved_at: now(), approved_by: req.user.user, iam_user_id: row.id, updated_at: now() })
  res.status(201).json(publicUser(row))
} catch (e) { next(e) } })
app.patch('/api/iam/signup-requests/:id/reject', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const signup = await one('signup_requests', { id: req.params.id })
  if (!signup || !['pending', 'oauth_pending'].includes(signup.status)) return res.status(404).json({ error: 'Open signup request not found.' })
  await update('signup_requests', { id: signup.id }, { status: 'rejected', password_hash: '', rejected_at: now(), rejected_by: req.user.user, rejection_note: String(req.body.note || '').slice(0, 500), updated_at: now() })
  res.json({ ok: true })
} catch (e) { next(e) } })

app.get('/api/iam/users', auth, permit('iam', { adminOnly: true }), async (_req, res, next) => { try {
  await ensureEnvironmentAdmin()
  const users = await list('iam_users')
  users.sort((a, b) => String(a.username).localeCompare(String(b.username)))
  res.json(users.map(publicUser))
} catch (e) { next(e) } })
app.post('/api/iam/users', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const username = String(req.body.username || '').trim(), key = usernameKey(username), password = String(req.body.password || '')
  const email = String(req.body.email || '').trim().toLocaleLowerCase()
  const role = ['admin', 'custom', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer'
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–50 characters and use only letters, numbers, dots, dashes or underscores.' })
  if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' })
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address for social login.' })
  if (await one('iam_users', { username_key: key })) return res.status(409).json({ error: 'That username already exists.' })
  if (email && (await list('iam_users')).some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === email)) return res.status(409).json({ error: 'That email is already linked to an IAM user.' })
  const permissions = role === 'custom' ? [...new Set(req.body.permissions || [])].filter((id) => CUSTOM_FEATURE_IDS.includes(id)) : role === 'admin' ? FEATURE_IDS : VIEWER_FEATURES
  const row = { id: randomUUID(), username, username_key: key, role, permissions, active: req.body.active !== false, source: 'managed', password_hash: await bcrypt.hash(password, 12), profile: email ? { email, email_key: email } : {}, created_at: now(), created_by: req.user.user, updated_at: now() }
  await insert('iam_users', row)
  res.status(201).json(publicUser(row))
} catch (e) { next(e) } })
app.patch('/api/iam/users/:id', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const user = await one('iam_users', { id: req.params.id })
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  if (user.source === 'environment') return res.status(400).json({ error: 'The environment administrator is managed through Vercel environment variables.' })
  const role = ['admin', 'custom', 'viewer'].includes(req.body.role) ? req.body.role : user.role
  const active = req.body.active === undefined ? user.active !== false : Boolean(req.body.active)
  const email = req.body.email === undefined ? String(user.profile?.email || '') : String(req.body.email || '').trim().toLocaleLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address for social login.' })
  if (email && (await list('iam_users')).some((row) => row.id !== user.id && usernameKey(row.profile?.email || row.profile?.email_key) === email)) return res.status(409).json({ error: 'That email is already linked to an IAM user.' })
  if (user.id === req.user.user_id && (role !== 'admin' || !active)) return res.status(400).json({ error: 'You cannot remove your own administrator access.' })
  const permissions = role === 'custom' ? [...new Set(req.body.permissions || [])].filter((id) => CUSTOM_FEATURE_IDS.includes(id)) : role === 'admin' ? FEATURE_IDS : VIEWER_FEATURES
  const patch = { role, active, permissions, profile: { ...(user.profile || {}), email, email_key: email }, updated_at: now(), updated_by: req.user.user }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' })
    patch.password_hash = await bcrypt.hash(String(req.body.password), 12)
  }
  await update('iam_users', { id: user.id }, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })
app.delete('/api/iam/users/:id', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const user = await one('iam_users', { id: req.params.id })
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  if (user.source === 'environment' || user.id === req.user.user_id) return res.status(400).json({ error: 'This administrator account cannot be deleted.' })
  await remove('iam_users', { id: user.id }); res.status(204).end()
} catch (e) { next(e) } })
app.put('/api/iam/users/:id/pem', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const user = await one('iam_users', { id: req.params.id })
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  const pem = String(req.body.pem || '').trim()
  if (!pem.includes('BEGIN PUBLIC KEY') && !pem.includes('BEGIN CERTIFICATE')) return res.status(400).json({ error: 'Upload a public PEM key or certificate. Private keys must stay on the user’s device.' })
  let key, canonical, der
  try {
    key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Only RSA keys are supported.')
    canonical = key.export({ type: 'spki', format: 'pem' }).toString()
    der = key.export({ type: 'spki', format: 'der' })
  } catch (error) { return res.status(400).json({ error: error.message || 'The public PEM file is invalid.' }) }
  const patch = { pem_public_key: canonical, pem_fingerprint: createHash('sha256').update(der).digest('hex').match(/.{1,2}/g).join(':'), pem_filename: String(req.body.filename || 'public-key.pem').slice(0, 160), pem_enrolled_at: now(), pem_enrolled_by: req.user.user, updated_at: now() }
  await update('iam_users', { id: user.id }, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })
app.delete('/api/iam/users/:id/pem', auth, permit('iam', { adminOnly: true }), async (req, res, next) => { try {
  const user = await one('iam_users', { id: req.params.id })
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  const patch = { pem_public_key: '', pem_fingerprint: '', pem_filename: '', pem_enrolled_at: '', pem_enrolled_by: '', updated_at: now() }
  await update('iam_users', { id: user.id }, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })

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
app.get('/api/sales', auth, permitAny(['dashboard', 'add-sale', 'review', 'update', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'passbook', 'ai', 'technical']), async (_req, res, next) => { try {
  const rows = await list('sales'); rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date))); res.json(rows)
} catch (e) { next(e) } })
app.post('/api/sales', auth, permitAny(['add-sale', 'passbook'], { write: true }), async (req, res, next) => { try {
  const row = saleFromBody(req.body)
  if (!row.customer_name || row.selling_price <= 0) return res.status(400).json({ error: 'Customer name and a valid selling price are required.' })
  row.id = await nextId('sales'); row.created_at = new Date().toISOString(); row.created_by = req.user.user
  await insert('sales', row); res.status(201).json(row)
} catch (e) { next(e) } })
app.put('/api/sales/:id', auth, permit('update', { write: true }), async (req, res, next) => { try {
  const id = Number(req.params.id), current = await one('sales', { id })
  if (!current) return res.status(404).json({ error: 'Transaction not found.' })
  const patch = saleFromBody({ ...current, ...req.body }); patch.updated_at = new Date().toISOString(); patch.updated_by = req.user.user
  await update('sales', { id }, patch); res.json({ ...current, ...patch })
} catch (e) { next(e) } })
app.delete('/api/sales/:id', auth, permit('update', { write: true }), async (req, res, next) => { try { await remove('sales', { id: Number(req.params.id) }); res.status(204).end() } catch (e) { next(e) } })
app.post('/api/sales/:id/payment', auth, permit('review', { write: true }), async (req, res, next) => { try {
  const id = Number(req.params.id), row = await one('sales', { id })
  if (!row) return res.status(404).json({ error: 'Transaction not found.' })
  const amount = Math.max(0, Math.min(Number(req.body.amount || 0), Number(row.pending_amount || 0)))
  if (!amount) return res.status(400).json({ error: 'Enter a valid collection amount.' })
  const paid = Number(row.amount_paid || 0) + amount, pending = Math.max(0, Number(row.selling_price || 0) - paid)
  const patch = { amount_paid: paid, pending_amount: pending, payment_received: pending <= 0 ? 1 : 0, last_payment_date: req.body.date || new Date().toISOString().slice(0, 10), last_payment_method: req.body.method || 'UPI', last_payment_received_by: req.body.received_by || req.user.user, updated_at: new Date().toISOString() }
  await update('sales', { id }, patch); res.json({ ...row, ...patch })
} catch (e) { next(e) } })

app.get('/api/notes', auth, permitAny(['notes', 'ai', 'technical']), async (_req, res, next) => { try { const rows = await list('work_notes'); rows.sort((a,b) => String(b.work_date).localeCompare(String(a.work_date))); res.json(rows) } catch (e) { next(e) } })
app.post('/api/notes', auth, permit('notes', { write: true }), async (req, res, next) => { try { const row = { id: await nextId('work_notes'), work_date: req.body.work_date, note: String(req.body.note || '').trim(), created_at: new Date().toISOString(), created_by: req.user.user }; if (!row.note) return res.status(400).json({ error: 'Note cannot be empty.' }); await insert('work_notes', row); res.json(row) } catch (e) { next(e) } })
app.delete('/api/notes/:id', auth, permit('notes', { write: true }), async (req, res, next) => { try { await remove('work_notes', { id: Number(req.params.id) }); res.status(204).end() } catch (e) { next(e) } })

app.get('/api/bills', auth, permit('bill'), async (_req, res, next) => { try { res.json(await list('bill_history')) } catch (e) { next(e) } })
app.post('/api/bills', auth, permit('bill', { write: true }), async (req, res, next) => { try { const row = { ...req.body, bill_id: `SKB-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(await nextId('bills')).padStart(4,'0')}`, generated_at: new Date().toISOString(), generated_by: req.user.user }; await insert('bill_history', row); res.json(row) } catch (e) { next(e) } })
app.post('/api/bills/generate', auth, permit('bill', { write: true }), async (req, res, next) => { try {
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
  const generated = await runPython('generate_bill', { sales: rows, customer_name: customerName, bill_id: billId, bill_date: billDate, bill_scope_label: scopeLabel }, 90000, pythonRequestContext(req))
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

app.get('/api/devices', auth, permit('security', { adminOnly: true }), async (_req, res, next) => { try { res.json(await list('auth_devices')) } catch (e) { next(e) } })
app.patch('/api/devices/:id', auth, permit('security', { adminOnly: true }), async (req, res, next) => { try { await update('auth_devices', { id: req.params.id }, { active: Boolean(req.body.active), updated_at: new Date().toISOString() }); res.json({ ok: true }) } catch (e) { next(e) } })

app.get('/api/settings', auth, permit('technical'), async (_req, res, next) => { try { res.json((await one('app_settings', { id: 'global' })) || {}) } catch (e) { next(e) } })
app.put('/api/settings', auth, permit('technical', { write: true }), async (req, res, next) => { try { const old = await one('app_settings', { id: 'global' }); const row = { ...old, ...req.body, id: 'global', updated_at: new Date().toISOString(), updated_by: req.user.user }; old ? await update('app_settings', { id: 'global' }, row) : await insert('app_settings', row); res.json(row) } catch (e) { next(e) } })

app.get('/api/backup', auth, permit('backup', { adminOnly: true }), async (_req, res, next) => { try { const data = {}; for (const name of backupCollections) data[name] = await list(name); res.setHeader('Content-Disposition', `attachment; filename="boutique-backup-${new Date().toISOString().slice(0,10)}.json"`); res.json({ version: 4, created_at: new Date().toISOString(), data }) } catch (e) { next(e) } })
app.post('/api/restore', auth, permit('backup', { adminOnly: true }), async (req, res, next) => { try { const data = req.body.data || {}; let inserted = 0; for (const name of backupCollections) for (const row of (data[name] || [])) { await insert(name, row); inserted++ } res.json({ inserted }) } catch (e) { next(e) } })

app.post('/api/passbook/parse', auth, permit('passbook', { write: true }), upload.array('files', 10), async (req, res, next) => { try {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose one or more PDF files.' })
  const files = req.files.map((file) => ({ filename: file.originalname, base64: file.buffer.toString('base64') }))
  res.json(await runPython('parse_passbooks', { files }, 90000, pythonRequestContext(req)))
} catch (e) { next(e) } })
app.get('/api/passbook/vendors', auth, permit('passbook'), async (_req, res, next) => { try {
  const rows = await list('passbook_vendors'); res.json(rows.map((row) => row.name).filter(Boolean).sort((a, b) => a.localeCompare(b)))
} catch (e) { next(e) } })
app.post('/api/passbook/vendors', auth, permit('passbook', { write: true }), async (req, res, next) => { try {
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim(), key = name.toLocaleLowerCase()
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' })
  const existing = await one('passbook_vendors', { key })
  const row = { key, name, updated_at: new Date().toISOString(), updated_by: req.user.user }
  existing ? await update('passbook_vendors', { key }, row) : await insert('passbook_vendors', { ...row, created_at: new Date().toISOString() })
  res.json(row)
} catch (e) { next(e) } })
app.delete('/api/passbook/vendors/:name', auth, permit('passbook', { write: true }), async (req, res, next) => { try {
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
app.post('/api/ai', auth, permit('ai'), async (req, res, next) => { try {
  const sales = (await list('sales')).slice(-150), notes = (await list('work_notes')).slice(-30)
  const context = JSON.stringify({ sales, notes }).slice(0, 80000)
  res.json({ answer: await askAI(String(req.body.question || ''), context) })
} catch (e) { next(e) } })

app.use((err, _req, res, _next) => { const message = readableError(err); console.error(message); res.status(500).json({ error: message }) })

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
