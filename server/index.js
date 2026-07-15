import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { MongoClient } from 'mongodb'
import nodemailer from 'nodemailer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto'

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

const BUSINESS_COLLECTIONS = ['sales', 'work_notes', 'bill_history', 'passbook_vendors', 'customer_credits', 'expenses']
const collections = [...BUSINESS_COLLECTIONS, 'workspaces', 'auth_devices', 'app_settings', 'iam_users', 'signup_requests', 'auth_challenges', 'oauth_states', 'oauth_tickets', 'backup_deliveries']
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
    await Promise.all([
      ...BUSINESS_COLLECTIONS.map((name) => database.collection(name).updateMany({ workspace_id: { $exists: false } }, { $set: { workspace_id: 'platform' } })),
      database.collection('auth_devices').updateMany({ workspace_id: { $exists: false } }, { $set: { workspace_id: 'platform' } }),
    ])
    await ensureEnvironmentAdmin()
    await ensurePersonalBoutique()
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

async function readTransient(name, id, match = {}) {
  const row = await one(name, { id })
  const current = now()
  if (!row || row.used || row.expires_at <= current || Object.entries(match).some(([key, value]) => row[key] !== value)) return null
  return clean(row)
}

const BUSINESS_FEATURES = ['dashboard', 'add-sale', 'review', 'update', 'customers', 'vendors', 'expenses', 'analytics', 'reminders', 'bill', 'passbook', 'notes', 'ai']
const OWNER_FEATURES = [...BUSINESS_FEATURES, 'gmail', 'iam', 'security', 'smtp', 'technical', 'backup', 'settings']
const PERSONAL_BOUTIQUE_FEATURES = OWNER_FEATURES
const FEATURE_IDS = [...PERSONAL_BOUTIQUE_FEATURES, 'platform']
const CUSTOM_FEATURE_IDS = OWNER_FEATURES
const VIEWER_FEATURES = ['dashboard', 'review', 'customers', 'vendors', 'expenses', 'analytics', 'reminders', 'bill', 'notes', 'ai']
const usernameKey = (value) => String(value || '').trim().toLocaleLowerCase()
const now = () => new Date().toISOString()

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: row.role === 'admin' ? FEATURE_IDS : row.role === 'owner' ? (row.source === 'personal_boutique' ? PERSONAL_BOUTIQUE_FEATURES : OWNER_FEATURES) : row.role === 'viewer' ? VIEWER_FEATURES : (row.permissions || []).filter((id) => CUSTOM_FEATURE_IDS.includes(id)),
    active: row.active !== false,
    source: row.source || 'managed',
    platform_admin: row.source === 'environment' || row.platform_admin === true,
    workspace_id: row.workspace_id || '',
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
    mfa: {
      email_otp: row.mfa_email_otp === true,
      email: row.profile?.email || row.profile?.email_key || '',
    },
  }
}

async function ensureEnvironmentAdmin() {
  const username = String(process.env.USERNAME || 'Admin').trim()
  const key = usernameKey(username)
  const environmentUsers = await list('iam_users', { source: 'environment' })
  const existing = environmentUsers.find((row) => row.username_key === key) || environmentUsers[0] || null
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLocaleLowerCase()
  const profile = adminEmail ? { ...(existing?.profile || {}), email: adminEmail, email_key: adminEmail } : (existing?.profile || {})
  const patch = { username, username_key: key, role: 'admin', permissions: FEATURE_IDS, active: true, source: 'environment', platform_admin: true, workspace_id: 'platform', profile, updated_at: now() }
  let administrator
  if (existing) {
    await update('iam_users', { id: existing.id }, patch)
    administrator = { ...existing, ...patch }
  } else {
    administrator = { id: randomUUID(), ...patch, created_at: now(), created_by: 'environment' }
    await insert('iam_users', administrator)
  }
  const users = await list('iam_users')
  for (const user of users.filter((row) => row.id !== administrator.id && (row.role === 'admin' || row.platform_admin || row.source === 'environment'))) {
    await update('iam_users', { id: user.id }, {
      role: 'custom', permissions: CUSTOM_FEATURE_IDS, platform_admin: false, active: false,
      source: user.source === 'environment' ? 'managed' : user.source, updated_at: now(), updated_by: 'environment',
    })
  }
  return administrator
}

async function sharedBoutiquePasswordHash(existingHash = '') {
  const configuredHash = String(process.env.PASSWORD_HASH || '').trim()
  if (configuredHash) return configuredHash
  const password = String(process.env.PASSWORD || '')
  if (!password) return existingHash
  if (existingHash) {
    try { if (await bcrypt.compare(password, existingHash)) return existingHash } catch { /* replace an invalid legacy hash */ }
  }
  return bcrypt.hash(password, 12)
}

async function ensurePersonalBoutique() {
  const username = String(process.env.BOUTIQUE_USERNAME || '').trim()
  const businessName = String(process.env.BOUTIQUE_NAME || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!username && !businessName) return null
  if (!username || !businessName) throw new Error('Configure both BOUTIQUE_USERNAME and BOUTIQUE_NAME.')
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) throw new Error('BOUTIQUE_USERNAME must use only letters, numbers, dots, dashes or underscores.')
  const key = usernameKey(username)
  if (key === usernameKey(process.env.USERNAME || 'Admin') || key === 'admin') throw new Error('BOUTIQUE_USERNAME must be different from the platform administrator.')

  const users = await list('iam_users')
  let user = users.find((row) => row.username_key === key) || null
  if (user?.source === 'signup' || user?.platform_admin || user?.source === 'environment') throw new Error('BOUTIQUE_USERNAME already belongs to another protected account.')

  let workspace = user?.workspace_id && user.workspace_id !== 'platform' ? await one('workspaces', { id: user.workspace_id }) : null
  if (!workspace) workspace = await one('workspaces', { kind: 'personal_boutique' })
  const createdAt = user?.created_at || workspace?.created_at || now(), workspaceId = workspace?.id || randomUUID(), userId = user?.id || randomUUID()
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLocaleLowerCase()
  const existingEmail = String(user?.profile?.email || '').trim().toLocaleLowerCase()
  const profile = {
    ...(user?.profile || {}), full_name: user?.profile?.full_name || businessName,
    organization_name: businessName, organization_type: user?.profile?.organization_type || 'Boutique',
    ...(adminEmail && existingEmail === adminEmail ? { email: '', email_key: '' } : {}),
  }
  const passwordHash = await sharedBoutiquePasswordHash(user?.password_hash || '')
  if (!passwordHash) throw new Error('Configure PASSWORD or PASSWORD_HASH before creating the personal boutique account.')

  const workspacePatch = {
    id: workspaceId, kind: 'personal_boutique', name: businessName, active: true, plan: workspace?.plan || 'owner', owner_user_id: userId,
    profile, signup_method: 'shared_password', updated_at: now(), created_at: workspace?.created_at || createdAt,
  }
  if (workspace) await update('workspaces', { id: workspace.id }, workspacePatch)
  else await insert('workspaces', workspacePatch)

  const userPatch = {
    username, username_key: key, role: 'owner', permissions: PERSONAL_BOUTIQUE_FEATURES, active: true, source: 'personal_boutique', platform_admin: false,
    workspace_id: workspaceId, signup_method: 'shared_password', password_hash: passwordHash, profile,
    auth_providers: user?.source === 'personal_boutique' ? (user.auth_providers || []) : [], updated_at: now(),
  }
  if (user) await update('iam_users', { id: user.id }, userPatch)
  else {
    user = { id: userId, ...userPatch, created_at: createdAt, created_by: 'environment_bootstrap' }
    await insert('iam_users', user)
  }

  if (database) {
    await Promise.all(BUSINESS_COLLECTIONS.map((name) => database.collection(name).updateMany({ workspace_id: 'platform' }, { $set: { workspace_id: workspaceId } })))
  } else {
    for (const name of BUSINESS_COLLECTIONS) for (const row of memory.get(name) || []) if (row.workspace_id === 'platform') row.workspace_id = workspaceId
  }
  return { user: { ...user, ...userPatch }, workspace: { ...workspace, ...workspacePatch } }
}

function workspaceName(profile = {}, username = '') {
  return String(profile.organization_name || `${profile.full_name || username || 'New'} workspace`).replace(/\s+/g, ' ').trim().slice(0, 160)
}

async function ensureUserWorkspace(user) {
  if (!user) return null
  if (user.source === 'environment' || user.platform_admin) {
    if (user.workspace_id === 'platform') return user
    const patch = { workspace_id: 'platform', platform_admin: true, role: 'admin', permissions: FEATURE_IDS, updated_at: now() }
    await update('iam_users', { id: user.id }, patch)
    return { ...user, ...patch }
  }
  if (user.workspace_id) return user
  if (user.source !== 'signup') {
    const patch = { workspace_id: 'platform', updated_at: now() }
    await update('iam_users', { id: user.id }, patch)
    return { ...user, ...patch }
  }
  const workspaceId = randomUUID(), profile = user.profile || {}
  const workspace = {
    id: workspaceId, name: workspaceName(profile, user.username), active: user.active !== false, plan: 'free', owner_user_id: user.id,
    profile: clean(profile), signup_method: user.signup_method || 'password', created_at: user.created_at || now(), updated_at: now(),
  }
  await insert('workspaces', workspace)
  const patch = { workspace_id: workspaceId, role: 'owner', permissions: OWNER_FEATURES, updated_at: now() }
  await update('iam_users', { id: user.id }, patch)
  return { ...user, ...patch }
}

async function workspaceIsActive(user) {
  if (!user || user.workspace_id === 'platform' || user.platform_admin || user.source === 'environment') return true
  const workspace = await one('workspaces', { id: user.workspace_id })
  return Boolean(workspace && workspace.active !== false)
}

const workspaceQuery = (req, query = {}) => ({ ...query, workspace_id: req.user.workspace_id || 'platform' })

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

function publicGmailOAuth(value = {}, req) {
  const clientId = value.client_id || process.env.GOOGLE_CLIENT_ID || ''
  return {
    configured: Boolean(clientId && (value.client_secret_encrypted || process.env.GOOGLE_CLIENT_SECRET)),
    client_id: clientId, client_secret_configured: Boolean(value.client_secret_encrypted || process.env.GOOGLE_CLIENT_SECRET),
    redirect_uri: req ? `${requestOrigin(req)}/api/gmail/oauth/callback` : '', updated_at: value.updated_at || '', updated_by: value.updated_by || '',
    source: value.client_secret_encrypted ? 'workspace' : (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'platform' : ''),
  }
}

function gmailOAuthInput(body = {}, old = {}) {
  const clientId = String(body.client_id || old.client_id || '').trim().slice(0, 250)
  const clientSecret = String(body.client_secret || '')
  if (!clientId) return { error: 'Enter the Google OAuth Client ID.' }
  if (!clientSecret && !old.client_secret_encrypted) return { error: 'Enter the Google OAuth Client Secret.' }
  return { value: {
    client_id: clientId, client_secret_encrypted: clientSecret ? encryptSecret(clientSecret) : old.client_secret_encrypted,
  } }
}

async function gmailOAuthSettings(req, workspaceId) {
  const settings = await one('app_settings', { id: `workspace:${workspaceId}` }), oauth = settings?.gmail_oauth || {}
  return {
    clientId: oauth.client_id || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: oauth.client_secret_encrypted ? decryptSecret(oauth.client_secret_encrypted) : (process.env.GOOGLE_CLIENT_SECRET || ''),
    redirectUri: `${requestOrigin(req)}/api/gmail/oauth/callback`,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  }
}

async function gmailAccess(workspaceId) {
  const id=`workspace:${workspaceId}`,settings=await one('app_settings',{id}),gmail=settings?.gmail
  if(!gmail?.refresh_token_encrypted)return null
  if(gmail.access_token_encrypted&&Date.parse(gmail.access_expires_at||'')>Date.now()+60000)return{token:decryptSecret(gmail.access_token_encrypted),gmail,settings}
  const oauth=settings?.gmail_oauth||{},clientId=oauth.client_id||process.env.GOOGLE_CLIENT_ID||'',clientSecret=oauth.client_secret_encrypted?decryptSecret(oauth.client_secret_encrypted):(process.env.GOOGLE_CLIENT_SECRET||'')
  if(!clientId||!clientSecret)throw new Error('Save this workspace’s Google OAuth Client ID and Client Secret before using Gmail.')
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:decryptSecret(gmail.refresh_token_encrypted),grant_type:'refresh_token'})})
  const token=await response.json().catch(()=>({}));if(!response.ok||!token.access_token)throw new Error(token.error_description||token.error||'Google access expired. Reconnect Gmail.')
  const patch={...gmail,access_token_encrypted:encryptSecret(token.access_token),access_expires_at:new Date(Date.now()+Number(token.expires_in||3600)*1000).toISOString(),updated_at:now()}
  await update('app_settings',{id},{gmail:patch,updated_at:now()});return{token:token.access_token,gmail:patch,settings}
}

async function gmailRequest(workspaceId,path,options={}){
  const access=await gmailAccess(workspaceId);if(!access)throw new Error('Connect a Gmail account first.')
  const response=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`,{...options,headers:{Authorization:`Bearer ${access.token}`,...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}})
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||'Gmail API request failed.');return data
}

function gmailHeader(message,name){return message.payload?.headers?.find(header=>header.name?.toLocaleLowerCase()===name.toLocaleLowerCase())?.value||''}
function gmailBody(part){if(part?.mimeType==='text/plain'&&part.body?.data)return Buffer.from(part.body.data.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');for(const child of(part?.parts||[])){const value=gmailBody(child);if(value)return value}if(part?.mimeType==='text/html'&&part.body?.data)return Buffer.from(part.body.data.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();return''}

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

function encryptSecret(value) {
  const key = createHash('sha256').update(process.env.SMTP_ENCRYPTION_KEY || jwtSecret).digest()
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
}

function decryptSecret(value) {
  const [version, ivValue, tagValue, encryptedValue] = String(value || '').split(':')
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('The saved SMTP password cannot be decrypted. Save the app password again.')
  const key = createHash('sha256').update(process.env.SMTP_ENCRYPTION_KEY || jwtSecret).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8')
}

function publicSmtp(value = {}) {
  return {
    provider: value.provider || 'gmail', enabled: value.enabled === true, host: value.host || 'smtp.gmail.com', port: Number(value.port || 465),
    secure: value.secure !== false, user: value.user || '', from_name: value.from_name || 'Business Manager', from_email: value.from_email || '',
    reply_to: value.reply_to || '', password_configured: Boolean(value.password_encrypted), updated_at: value.updated_at || '', updated_by: value.updated_by || '',
  }
}

function smtpInput(body, old = {}) {
  const provider = body.provider === 'custom' ? 'custom' : 'gmail'
  const host = String(body.host || (provider === 'gmail' ? 'smtp.gmail.com' : '')).trim().slice(0, 200)
  const portValue = Number(body.port || (body.secure === false ? 587 : 465)), port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 0
  const user = String(body.user || '').trim().slice(0, 250), fromEmail = String(body.from_email || user).trim().toLocaleLowerCase().slice(0, 250)
  const replyTo = String(body.reply_to || '').trim().toLocaleLowerCase().slice(0, 250), password = String(body.password || '')
  if (!host || !port || !user) return { error: 'SMTP host, port and username are required.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) return { error: 'Enter a valid From email address.' }
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return { error: 'Enter a valid Reply-to email address.' }
  if (!password && !old.password_encrypted) return { error: provider === 'gmail' ? 'Enter a Google App Password.' : 'Enter the SMTP password.' }
  return { value: {
    provider, enabled: body.enabled !== false, host, port, secure: body.secure !== false, user,
    from_name: String(body.from_name || 'Business Manager').replace(/[\r\n]/g, ' ').trim().slice(0, 120), from_email: fromEmail, reply_to: replyTo,
    password_encrypted: password ? encryptSecret(provider === 'gmail' ? password.replace(/\s/g, '') : password) : old.password_encrypted,
  } }
}

function smtpTransport(settings) {
  if (!settings?.password_encrypted) throw new Error('SMTP credentials are not configured.')
  return nodemailer.createTransport({
    host: settings.host, port: Number(settings.port), secure: settings.secure === true,
    auth: { user: settings.user, pass: decryptSecret(settings.password_encrypted) },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, tls: { minVersion: 'TLSv1.2' },
  })
}

async function sendConfiguredEmail({ to, subject, text, html, attachments }, { allowDisabled = false, workspaceId = 'global' } = {}) {
  const settings = await one('app_settings', { id: workspaceId === 'global' ? 'global' : `workspace:${workspaceId}` }), smtp = settings?.smtp
  if (!smtp?.enabled && !allowDisabled) throw new Error('SMTP email sending is not enabled.')
  const transporter = smtpTransport(smtp)
  return transporter.sendMail({ from: { name: smtp.from_name || 'Business Manager', address: smtp.from_email }, replyTo: smtp.reply_to || undefined, to, subject, text, html, attachments })
}

function otpCode() { return String(Math.floor(100000 + Math.random() * 900000)) }
async function createEmailOtp(email, purpose, metadata = {}) {
  const code = otpCode(), row = { id: randomUUID(), purpose, email: usernameKey(email), code_hash: await bcrypt.hash(code, 10), metadata: clean(metadata), used: false, created_at: now(), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  await insert('auth_challenges', row)
  await sendConfiguredEmail({ to: email, subject: `Business Manager verification code: ${code}`, text: `Your Business Manager verification code is ${code}. It expires in 10 minutes.`, html: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px"><h2 style="color:#2563eb">Verify your email</h2><p>Use this one-time code:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>` })
  return row.id
}
async function verifyEmailOtp(email, purpose, code) {
  const rows = (await list('auth_challenges')).filter((row) => row.purpose === purpose && row.email === usernameKey(email) && !row.used && row.expires_at > now()).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)))
  const row = rows[0]
  if (!row || Number(row.attempts || 0) >= 5) return false
  if (!(await bcrypt.compare(String(code || ''), row.code_hash))) { await update('auth_challenges', { id: row.id }, { attempts: Number(row.attempts || 0) + 1, last_attempt_at: now() }); return false }
  await update('auth_challenges', { id: row.id }, { used: true, used_at: now() })
  return true
}

function userEmail(user = {}) {
  return String(user.profile?.email || user.profile?.email_key || '').trim().toLocaleLowerCase()
}

async function createLoginMfa(req, user, method) {
  const email = userEmail(user)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email OTP MFA is enabled, but this user does not have a valid email address in IAM.')
  const code = otpCode(), row = {
    id: randomUUID(), purpose: 'login_mfa', email: usernameKey(email), user_id: user.id, workspace_id: user.workspace_id || 'platform',
    method, code_hash: await bcrypt.hash(code, 10), used: false, created_at: now(), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    user_agent: req.headers['user-agent'] || '',
  }
  await insert('auth_challenges', row)
  await sendConfiguredEmail({
    to: email,
    subject: `Business Manager login code: ${code}`,
    text: `Your Business Manager login code is ${code}. It expires in 10 minutes.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px"><h2 style="color:#2563eb">Confirm your login</h2><p>Use this one-time code to finish signing in:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not try to sign in, change your password and revoke unknown devices.</p></div>`,
  })
  return { mfa_required: true, challenge_id: row.id, email_hint: email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2'), expires_at: row.expires_at }
}

async function finishLogin(req, res, user, method) {
  if (user.mfa_email_otp === true) return res.json(await createLoginMfa(req, user, method))
  const device = await recordLogin(req, user, method)
  return res.json({ token: sign(user, device.id), user: publicUser(user), deviceId: device.id })
}

async function verifyLoginMfa(req, res, user, challengeId, code) {
  const challenge = await readTransient('auth_challenges', challengeId, { purpose: 'login_mfa' })
  if (!challenge || challenge.user_id !== user.id || challenge.email !== usernameKey(userEmail(user)) || Number(challenge.attempts || 0) >= 5) return res.status(401).json({ error: 'The login verification code is invalid or expired.' })
  if (!(await bcrypt.compare(String(code || ''), challenge.code_hash))) { await update('auth_challenges', { id: challenge.id }, { attempts: Number(challenge.attempts || 0) + 1, last_attempt_at: now() }); return res.status(401).json({ error: 'The login verification code is invalid or expired.' }) }
  await update('auth_challenges', { id: challenge.id }, { used: true, used_at: now() })
  const device = await recordLogin(req, user, challenge.method || 'password')
  return res.json({ token: sign(user, device.id), user: publicUser(user), deviceId: device.id })
}

function smtpErrorMessage(error) {
  const message = readableError(error, 'SMTP connection failed.')
  if (error?.code === 'EAUTH' || error?.responseCode === 535 || /535|BadCredentials|Username and Password not accepted/i.test(message)) {
    return 'Gmail rejected the username or password. Use the complete Google email as the SMTP username and a current 16-character Google App Password, not the normal account password.'
  }
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED'].includes(error?.code) || /timed?\s*out|connection refused/i.test(message)) {
    return 'The SMTP server could not be reached. Check the host, port and connection security, then try again.'
  }
  return message
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
  return jwt.sign({ user: user.username, user_id: user.id, workspace_id: user.workspace_id, role: user.role, permissions: publicUser(user).permissions, device_id: deviceId }, jwtSecret, { expiresIn: '12h' })
}

async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const payload = jwt.verify(token, jwtSecret)
    let user
    if (payload.user_id) user = await one('iam_users', { id: payload.user_id })
    else if (payload.role === 'admin' && usernameKey(payload.user) === usernameKey(process.env.USERNAME || 'Admin')) user = await ensureEnvironmentAdmin()
    user = await ensureUserWorkspace(user)
    if (!user || user.active === false || !(await workspaceIsActive(user))) return res.status(401).json({ error: 'This account or workspace is inactive.' })
    if (payload.device_id) {
      const device = await one('auth_devices', { id: payload.device_id })
      if (device && device.active === false) return res.status(401).json({ error: 'This device session was revoked.' })
    }
    req.user = { user: user.username, username: user.username, user_id: user.id, workspace_id: user.workspace_id, role: user.role, platform_admin: user.source === 'environment' || user.platform_admin === true, permissions: publicUser(user).permissions, device_id: payload.device_id }
    next()
  } catch { res.status(401).json({ error: 'Please sign in again.' }) }
}

function canAccess(user, feature, write = false) {
  if (user.platform_admin) return feature === 'platform'
  if (user.role === 'admin') return true
  if (user.role === 'owner') return (user.permissions || OWNER_FEATURES).includes(feature)
  if (user.role === 'viewer') return !write && VIEWER_FEATURES.includes(feature)
  return user.role === 'custom' && (user.permissions || []).includes(feature)
}

function permit(feature, { write = false, adminOnly = false } = {}) {
  return (req, res, next) => {
    if (req.user.platform_admin && feature !== 'platform') return res.status(403).json({ error: 'The platform administrator is limited to the Customer Accounts console.' })
    if (adminOnly && req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' })
    if (!adminOnly && !canAccess(req.user, feature, write)) return res.status(403).json({ error: write ? 'You do not have permission to change this feature.' : 'You do not have access to this feature.' })
    next()
  }
}

function permitAny(features, { write = false } = {}) {
  return (req, res, next) => {
    if (req.user.platform_admin) return res.status(403).json({ error: 'The platform administrator is limited to the Customer Accounts console.' })
    if (!features.some((feature) => canAccess(req.user, feature, write))) return res.status(403).json({ error: 'You do not have permission to perform this action.' })
    next()
  }
}

function platformOnly(req, res, next) {
  if (!req.user.platform_admin) return res.status(403).json({ error: 'Platform administrator access is required.' })
  next()
}

async function recordLogin(req, user, method) {
  const device = { id: randomUUID(), username: user.username, user_id: user.id, workspace_id: user.workspace_id || 'platform', role: user.role, active: true, login_method: method, last_login_at: now(), user_agent: req.headers['user-agent'] || '' }
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
  const expectedUser = process.env.USERNAME || 'Admin'
  let user = await one('iam_users', { username_key: usernameKey(username) })
  if (!user && usernameKey(username) === usernameKey(process.env.BOUTIQUE_USERNAME || '')) {
    await ensurePersonalBoutique()
    user = await one('iam_users', { username_key: usernameKey(username) })
  }
  let validPassword = false
  if (usernameKey(username) === usernameKey(expectedUser)) {
    if (process.env.VERCEL && !process.env.PASSWORD && !process.env.PASSWORD_HASH) {
      return res.status(503).json({ error: 'The platform administrator password is not configured.' })
    }
    validPassword = process.env.PASSWORD_HASH
      ? await bcrypt.compare(password, process.env.PASSWORD_HASH)
      : password === (process.env.PASSWORD || 'admin')
    if (validPassword) user = await ensureEnvironmentAdmin()
  } else if (user?.password_hash) validPassword = await bcrypt.compare(password, user.password_hash)
  user = await ensureUserWorkspace(user)
  if (!user || user.active === false || !validPassword || !(await workspaceIsActive(user))) return res.status(401).json({ error: 'Invalid username or password, or the workspace is inactive.' })
  return finishLogin(req, res, user, 'password')
})

app.post('/api/auth/mfa/verify', async (req, res, next) => { try {
  const challenge = await readTransient('auth_challenges', String(req.body.challenge_id || ''), { purpose: 'login_mfa' })
  if (!challenge) return res.status(401).json({ error: 'The login verification session is invalid or expired.' })
  const user = await ensureUserWorkspace(await one('iam_users', { id: challenge.user_id }))
  if (!user || user.active === false || !(await workspaceIsActive(user))) return res.status(401).json({ error: 'This account or workspace is inactive.' })
  return verifyLoginMfa(req, res, user, challenge.id, req.body.otp)
} catch (e) { next(e) } })

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
    logo: String(body.logo || '').trim(),
  }
  const password = String(body.password || ''), confirmPassword = String(body.confirm_password || '')
  if (!data.full_name || !data.organization_name || !data.organization_type || !data.city || !data.state || !data.country) return { error: 'Complete all required contact and organisation details.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return { error: 'Enter a valid business email address.' }
  const phoneDigits = data.phone.replace(/\D/g, '')
  if (phoneDigits.length < 7 || phoneDigits.length > 16) return { error: 'Enter a valid phone number.' }
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(data.requested_username)) return { error: 'Username must be 3–50 characters and use only letters, numbers, dots, dashes or underscores.' }
  if (body.terms !== true) return { error: 'Confirm the registration information and access terms.' }
  if (data.logo && (!/^data:image\/(png|jpeg|webp);base64,/i.test(data.logo) || data.logo.length > 1400000)) return { error: 'Upload a PNG, JPEG or WebP logo smaller than 1 MB.' }
  if (passwordRequired && (password.length < 8 || password !== confirmPassword)) return { error: password !== confirmPassword ? 'Passwords do not match.' : 'Use a password with at least 8 characters.' }
  return { data: { ...data, email_key: data.email, username_key: usernameKey(data.requested_username) }, password }
}

async function accountConflict(data) {
  const reservedAdmin = usernameKey(process.env.USERNAME || 'Admin')
  if (data.username_key === reservedAdmin || data.username_key === 'admin') return { error: 'That username is reserved for platform administration.' }
  const users = await list('iam_users')
  if (users.some((user) => user.username_key === data.username_key)) return { error: 'That username already belongs to an IAM account.' }
  if (users.some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === data.email_key)) return { error: 'An IAM account already exists for this email. Please log in instead.' }
  return null
}

async function createWorkspaceAccount(req, { data, password = '', identity = null }) {
  const conflict = await accountConflict(data)
  if (conflict) return conflict
  const workspaceId = randomUUID(), userId = randomUUID(), createdAt = now(), signupMethod = identity?.provider || 'password'
  const profile = {
    full_name: data.full_name, email: data.email, email_key: data.email_key, phone: data.phone, organization_name: data.organization_name,
    organization_type: data.organization_type, job_title: data.job_title, team_size: data.team_size, website: data.website,
    city: data.city, state: data.state, country: data.country, use_case: data.use_case, how_heard: data.how_heard, picture: identity?.picture || '', logo: data.logo || '',
  }
  const workspace = {
    id: workspaceId, name: workspaceName(profile, data.requested_username), active: true, plan: 'free', owner_user_id: userId,
    profile, signup_method: signupMethod, created_at: createdAt, updated_at: createdAt,
  }
  const user = {
    id: userId, username: data.requested_username, username_key: data.username_key, role: 'owner', permissions: OWNER_FEATURES, active: true,
    source: 'signup', workspace_id: workspaceId, signup_method: signupMethod, password_hash: password ? await bcrypt.hash(password, 12) : '', profile,
    auth_providers: identity ? [{ provider: identity.provider, subject: identity.subject, email: identity.email, linked_at: createdAt }] : [],
    created_at: createdAt, created_by: 'self_signup', updated_at: createdAt,
  }
  const { logo: _logo, ...signupData } = data
  const signup = {
    id: randomUUID(), ...signupData, workspace_id: workspaceId, iam_user_id: userId, signup_method: signupMethod, status: 'active', terms_accepted: true,
    oauth_provider: identity?.provider || '', oauth_subject: identity?.subject || '', verified_at: identity ? createdAt : '',
    created_at: createdAt, activated_at: createdAt, updated_at: createdAt, user_agent: req.headers['user-agent'] || '',
  }
  await insert('workspaces', workspace)
  await insert('iam_users', user)
  await insert('signup_requests', signup)
  const device = await recordLogin(req, user, identity ? identity.provider : 'password')
  return { workspace, user, signup, device, token: sign(user, device.id) }
}

app.post('/api/auth/signup/otp', async (req, res, next) => { try {
  const email = String(req.body.email || '').trim().toLocaleLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid business email address.' })
  const users = await list('iam_users')
  if (users.some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === email)) return res.status(409).json({ error: 'An account already exists for this email. Please log in.' })
  await createEmailOtp(email, 'signup')
  res.json({ ok: true, message: 'Verification code sent. It expires in 10 minutes.' })
} catch (e) { next(e) } })

app.post('/api/auth/signup', async (req, res, next) => { try {
  const parsed = signupInput(req.body, true)
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  if (!(await verifyEmailOtp(parsed.data.email, 'signup', req.body.otp))) return res.status(400).json({ error: 'Enter the valid email verification code.' })
  const result = await createWorkspaceAccount(req, { data: parsed.data, password: parsed.password })
  if (result.error) return res.status(400).json({ error: result.error })
  res.status(201).json({ ok: true, token: result.token, user: publicUser(result.user), workspace: result.workspace, message: 'Your private workspace is ready.' })
} catch (e) { next(e) } })

app.post('/api/auth/forgot-password/otp', async (req, res, next) => { try {
  const email = String(req.body.email || '').trim().toLocaleLowerCase(), users = await list('iam_users')
  const user = users.find((row) => usernameKey(row.profile?.email || row.profile?.email_key) === email && row.active !== false)
  if (user && user.source !== 'environment') await createEmailOtp(email, 'password_reset', { user_id: user.id })
  res.json({ ok: true, message: 'If that email belongs to an active account, a verification code has been sent.' })
} catch (e) { next(e) } })

app.post('/api/auth/forgot-password/reset', async (req, res, next) => { try {
  const email = String(req.body.email || '').trim().toLocaleLowerCase(), password = String(req.body.password || '')
  if (password.length < 8 || password !== String(req.body.confirm_password || '')) return res.status(400).json({ error: 'Passwords must match and contain at least 8 characters.' })
  const users = await list('iam_users'), user = users.find((row) => usernameKey(row.profile?.email || row.profile?.email_key) === email && row.active !== false && row.source !== 'environment')
  if (!user || !(await verifyEmailOtp(email, 'password_reset', req.body.otp))) return res.status(400).json({ error: 'The reset code is invalid or expired.' })
  await update('iam_users', { id: user.id }, { password_hash: await bcrypt.hash(password, 12), updated_at: now(), password_reset_at: now() })
  res.json({ ok: true, message: 'Password updated. You can now sign in.' })
} catch (e) { next(e) } })
app.get('/api/auth/oauth/:provider/start', async (req, res, next) => { try {
  const settings = oauthSettings(req.params.provider, req)
  if (!settings) return res.redirect(landingRedirect(req, 'oauth_error', 'Unsupported sign-in provider.'))
  if (!settings.clientId || !settings.clientSecret) return res.redirect(landingRedirect(req, 'oauth_error', `${settings.label} sign-in is not configured yet.`))
  const state = { id: randomUUID(), provider: settings.provider, intent: 'continue', used: false, created_at: now(), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  await insert('oauth_states', state)
  const url = new URL(settings.authorizeUrl)
  url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code', scope: settings.scope, state: state.id, prompt: 'select_account' }).toString()
  res.redirect(url.toString())
} catch (e) { next(e) } })

app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
  const settings = oauthSettings(req.params.provider, req)
  try {
    if (!settings) throw new Error('Unsupported sign-in provider.')
    const state = await consumeTransient('oauth_states', String(req.query.state || ''), { provider: settings.provider })
    if (!state) throw new Error('The sign-in request is invalid or expired.')
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error))
    const identity = await exchangeOAuthCode(settings, String(req.query.code || ''))
    let user = await findIamUserForOAuth(identity)
    if (!user) {
      const ticket = {
        id: randomUUID(), purpose: 'signup', identity, used: false, created_at: now(),
        expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      }
      await insert('oauth_tickets', ticket)
      return res.redirect(landingRedirect(req, 'oauth_signup_ticket', ticket.id))
    }
    user = await ensureUserWorkspace(user)
    if (user.active === false || !(await workspaceIsActive(user))) throw new Error('This account or workspace is disabled. Contact support.')
    if (!(user.auth_providers || []).some((provider) => provider.provider === identity.provider && provider.subject === identity.subject)) {
      const authProviders = [...(user.auth_providers || []).filter((provider) => provider.provider !== identity.provider), { provider: identity.provider, subject: identity.subject, email: identity.email, linked_at: now() }]
      const profile = { ...(user.profile || {}), email: identity.email, email_key: identity.email, full_name: user.profile?.full_name || identity.name, picture: identity.picture || user.profile?.picture || '' }
      await update('iam_users', { id: user.id }, { auth_providers: authProviders, profile, updated_at: now() })
      user = { ...user, auth_providers: authProviders, profile }
    }
    const ticket = { id: randomUUID(), purpose: 'login', user_id: user.id, method: identity.provider, used: false, created_at: now(), expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
    await insert('oauth_tickets', ticket)
    res.redirect(landingRedirect(req, 'oauth_ticket', ticket.id))
  } catch (error) { res.redirect(landingRedirect(req, 'oauth_error', readableError(error, 'Social sign-in failed.'))) }
})

app.post('/api/auth/oauth/exchange', async (req, res, next) => { try {
  const ticket = await consumeTransient('oauth_tickets', String(req.body.ticket || ''), { purpose: 'login' })
  if (!ticket) return res.status(401).json({ error: 'The social sign-in ticket is invalid or expired.' })
  const user = await one('iam_users', { id: ticket.user_id })
  const activeUser = await ensureUserWorkspace(user)
  if (!activeUser || activeUser.active === false || !(await workspaceIsActive(activeUser))) return res.status(401).json({ error: 'This account or workspace is not active.' })
  return finishLogin(req, res, activeUser, ticket.method || 'oauth')
} catch (e) { next(e) } })

app.post('/api/auth/oauth/signup-context', async (req, res, next) => { try {
  const ticket = await readTransient('oauth_tickets', String(req.body.ticket || ''), { purpose: 'signup' })
  if (!ticket) return res.status(401).json({ error: 'The social signup session is invalid or expired. Continue with the provider again.' })
  const identity = ticket.identity || {}
  const suggestedUsername = String(identity.email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 50)
  res.json({ provider: identity.provider, email: identity.email, name: identity.name, picture: identity.picture, suggested_username: suggestedUsername })
} catch (e) { next(e) } })

app.post('/api/auth/signup/oauth/complete', async (req, res, next) => { try {
  const ticketId = String(req.body.oauth_ticket || '')
  const pendingTicket = await readTransient('oauth_tickets', ticketId, { purpose: 'signup' })
  if (!pendingTicket) return res.status(401).json({ error: 'The social signup session is invalid or expired. Continue with the provider again.' })
  const identity = pendingTicket.identity || {}
  const parsed = signupInput({ ...req.body, email: identity.email, full_name: req.body.full_name || identity.name }, false)
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  const conflict = await accountConflict(parsed.data)
  if (conflict) return res.status(409).json({ error: conflict.error })
  const consumedTicket = await consumeTransient('oauth_tickets', ticketId, { purpose: 'signup' })
  if (!consumedTicket) return res.status(409).json({ error: 'This social signup session was already used. Continue with the provider again.' })
  const result = await createWorkspaceAccount(req, { data: parsed.data, identity })
  if (result.error) return res.status(409).json({ error: result.error })
  res.status(201).json({ ok: true, token: result.token, user: publicUser(result.user), workspace: result.workspace, message: 'Your private workspace is ready.' })
} catch (e) { next(e) } })

app.post('/api/auth/pem/challenge', async (req, res, next) => { try {
  const key = usernameKey(req.body.username)
  const user = await ensureUserWorkspace(await one('iam_users', { username_key: key }))
  if (!user || user.active === false || !(await workspaceIsActive(user)) || !user.pem_public_key) return res.status(401).json({ error: 'PEM sign-in is not configured for this active workspace.' })
  const row = { id: randomUUID(), username_key: key, challenge: randomBytes(32).toString('base64'), created_at: now(), expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), used: false }
  await insert('auth_challenges', row)
  res.json({ challenge_id: row.id, challenge: row.challenge, expires_at: row.expires_at })
} catch (e) { next(e) } })
app.post('/api/auth/pem/login', async (req, res, next) => { try {
  const key = usernameKey(req.body.username), challengeId = String(req.body.challenge_id || ''), signature = String(req.body.signature || '')
  const user = await ensureUserWorkspace(await one('iam_users', { username_key: key }))
  const challenge = await consumeChallenge(challengeId, key)
  if (!user || user.active === false || !(await workspaceIsActive(user)) || !user.pem_public_key || !challenge) return res.status(401).json({ error: 'The PEM challenge is invalid, expired, or belongs to an inactive workspace.' })
  let valid = false
  try { valid = verifySignature('sha256', Buffer.from(challenge.challenge, 'base64'), user.pem_public_key, Buffer.from(signature, 'base64')) } catch { valid = false }
  if (!valid) return res.status(401).json({ error: 'The PEM file does not match this account.' })
  return finishLogin(req, res, user, 'pem')
} catch (e) { next(e) } })
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await one('iam_users', { id: req.user.user_id })
  res.json(publicUser(user))
})

app.get('/api/iam/users', auth, permit('iam'), async (req, res, next) => { try {
  const users = await list('iam_users', workspaceQuery(req))
  users.sort((a, b) => String(a.username).localeCompare(String(b.username)))
  res.json(users.map(publicUser))
} catch (e) { next(e) } })
app.post('/api/iam/users', auth, permit('iam', { write: true }), async (req, res, next) => { try {
  const username = String(req.body.username || '').trim(), key = usernameKey(username), password = String(req.body.password || '')
  const email = String(req.body.email || '').trim().toLocaleLowerCase()
  const role = ['custom', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer'
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–50 characters and use only letters, numbers, dots, dashes or underscores.' })
  if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' })
  if (key === usernameKey(process.env.USERNAME || 'Admin') || key === 'admin') return res.status(400).json({ error: 'That username is reserved for platform administration.' })
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address for social login.' })
  if (await one('iam_users', { username_key: key })) return res.status(409).json({ error: 'That username already exists.' })
  if (email && (await list('iam_users')).some((user) => usernameKey(user.profile?.email || user.profile?.email_key) === email)) return res.status(409).json({ error: 'That email is already linked to an IAM user.' })
  const permissions = role === 'custom' ? [...new Set(req.body.permissions || [])].filter((id) => CUSTOM_FEATURE_IDS.includes(id)) : VIEWER_FEATURES
  const row = { id: randomUUID(), username, username_key: key, role, permissions, active: req.body.active !== false, source: 'managed', workspace_id: req.user.workspace_id, platform_admin: false, password_hash: await bcrypt.hash(password, 12), profile: email ? { email, email_key: email } : {}, created_at: now(), created_by: req.user.user, updated_at: now() }
  await insert('iam_users', row)
  res.status(201).json(publicUser(row))
} catch (e) { next(e) } })
app.patch('/api/iam/users/:id', auth, permit('iam', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), user = await one('iam_users', query)
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  if (user.role === 'owner' || user.source === 'personal_boutique') return res.status(400).json({ error: 'The workspace owner account is protected. Update its profile in Settings.' })
  const role = ['custom', 'viewer'].includes(req.body.role) ? req.body.role : (user.role === 'admin' ? 'custom' : user.role)
  const active = req.body.active === undefined ? user.active !== false : Boolean(req.body.active)
  const email = req.body.email === undefined ? String(user.profile?.email || '') : String(req.body.email || '').trim().toLocaleLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address for social login.' })
  if (email && (await list('iam_users')).some((row) => row.id !== user.id && usernameKey(row.profile?.email || row.profile?.email_key) === email)) return res.status(409).json({ error: 'That email is already linked to an IAM user.' })
  const permissions = role === 'custom' ? [...new Set(req.body.permissions || [])].filter((id) => CUSTOM_FEATURE_IDS.includes(id)) : VIEWER_FEATURES
  const patch = { role, active, permissions, platform_admin: false, profile: { ...(user.profile || {}), email, email_key: email }, updated_at: now(), updated_by: req.user.user }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' })
    patch.password_hash = await bcrypt.hash(String(req.body.password), 12)
  }
  await update('iam_users', query, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })
app.delete('/api/iam/users/:id', auth, permit('iam', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), user = await one('iam_users', query)
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  if (user.source === 'personal_boutique' || user.id === req.user.user_id) return res.status(400).json({ error: 'The workspace owner account cannot be deleted.' })
  await remove('iam_users', query); res.status(204).end()
} catch (e) { next(e) } })
app.put('/api/iam/users/:id/pem', auth, permit('iam', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), user = await one('iam_users', query)
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
  await update('iam_users', query, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })
app.delete('/api/iam/users/:id/pem', auth, permit('iam', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), user = await one('iam_users', query)
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  const patch = { pem_public_key: '', pem_fingerprint: '', pem_filename: '', pem_enrolled_at: '', pem_enrolled_by: '', updated_at: now() }
  await update('iam_users', query, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })

function saleFromBody(body) {
  const selling = Number(body.selling_price || 0), buying = Number(body.buying_price || 0), paid = Number(body.amount_paid || 0)
  return {
    customer_name: String(body.customer_name || '').trim(), customer_phone: String(body.customer_phone || '').trim(),
    sale_date: body.sale_date || new Date().toISOString().slice(0, 10), vendor: String(body.vendor || '').trim(),
    product_category: body.product_category || 'Other', product_description: String(body.product_description || '').trim(),
    buying_price: buying, selling_price: selling, amount_paid: Math.min(paid, selling), pending_amount: Math.max(0, selling - paid), store_credit_generated: Math.max(0, paid - selling),
    payment_received: paid >= selling ? 1 : 0, delay_status: body.delay_status ? 1 : 0,
    payment_method: body.payment_method || 'UPI', notes: String(body.notes || '').trim(),
    quantity: Math.max(1, Number(body.quantity || 1)),
    ...(body.passbook_source ? { passbook_source: clean(body.passbook_source) } : {}),
  }
}
app.get('/api/sales', auth, permitAny(['dashboard', 'add-sale', 'review', 'update', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'passbook', 'ai', 'technical']), async (req, res, next) => { try {
  const rows = await list('sales', workspaceQuery(req)); rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date))); res.json(rows)
} catch (e) { next(e) } })
app.post('/api/sales', auth, permitAny(['add-sale', 'passbook'], { write: true }), async (req, res, next) => { try {
  const row = saleFromBody(req.body)
  if (!row.customer_name || row.selling_price <= 0) return res.status(400).json({ error: 'Customer name and a valid selling price are required.' })
  row.id = await nextId('sales'); row.workspace_id = req.user.workspace_id; row.created_at = new Date().toISOString(); row.created_by = req.user.user
  await insert('sales', row)
  if (row.store_credit_generated > 0) await insert('customer_credits', { id:randomUUID(), workspace_id:req.user.workspace_id, customer_key:usernameKey(row.customer_name), customer_name:row.customer_name, customer_phone:row.customer_phone, amount:row.store_credit_generated, type:'credit', source_sale_id:row.id, created_at:now(), created_by:req.user.user })
  res.status(201).json(row)
} catch (e) { next(e) } })
app.put('/api/sales/:id', auth, permit('update', { write: true }), async (req, res, next) => { try {
  const id = Number(req.params.id), query = workspaceQuery(req, { id }), current = await one('sales', query)
  if (!current) return res.status(404).json({ error: 'Transaction not found.' })
  const patch = saleFromBody({ ...current, ...req.body }); patch.updated_at = new Date().toISOString(); patch.updated_by = req.user.user
  await update('sales', query, patch); res.json({ ...current, ...patch })
} catch (e) { next(e) } })
app.delete('/api/sales/:id', auth, permit('update', { write: true }), async (req, res, next) => { try { await remove('sales', workspaceQuery(req, { id: Number(req.params.id) })); res.status(204).end() } catch (e) { next(e) } })
app.post('/api/sales/:id/payment', auth, permit('review', { write: true }), async (req, res, next) => { try {
  const id = Number(req.params.id), query = workspaceQuery(req, { id }), row = await one('sales', query)
  if (!row) return res.status(404).json({ error: 'Transaction not found.' })
  const received = Math.max(0, Number(req.body.amount || 0)), amount = Math.min(received, Number(row.pending_amount || 0)), credit = Math.max(0, received - amount)
  if (!amount) return res.status(400).json({ error: 'Enter a valid collection amount.' })
  const paid = Number(row.amount_paid || 0) + amount, pending = Math.max(0, Number(row.selling_price || 0) - paid)
  const patch = { amount_paid: paid, pending_amount: pending, payment_received: pending <= 0 ? 1 : 0, last_payment_date: req.body.date || new Date().toISOString().slice(0, 10), last_payment_method: req.body.method || 'UPI', last_payment_received_by: req.body.received_by || req.user.user, updated_at: new Date().toISOString() }
  await update('sales', query, patch)
  if (credit > 0) await insert('customer_credits', { id:randomUUID(), workspace_id:req.user.workspace_id, customer_key:usernameKey(row.customer_name), customer_name:row.customer_name, customer_phone:row.customer_phone, amount:credit, type:'credit', source_sale_id:row.id, created_at:now(), created_by:req.user.user })
  res.json({ ...row, ...patch, store_credit_added:credit })
} catch (e) { next(e) } })

app.get('/api/customer-credits', auth, permitAny(['dashboard','add-sale','review','customers','bill']), async (req,res,next)=>{try{
  const rows=await list('customer_credits',workspaceQuery(req)), balances={}
  for(const row of rows) balances[row.customer_key]=(balances[row.customer_key]||0)+(row.type==='debit'?-1:1)*Number(row.amount||0)
  res.json({rows,balances})
}catch(e){next(e)}})

function expenseFromBody(body) {
  const amount = Math.max(0, Number(body.amount || 0))
  return {
    expense_date: body.expense_date || new Date().toISOString().slice(0, 10),
    category: String(body.category || 'General').trim().slice(0, 80),
    description: String(body.description || '').trim().slice(0, 500),
    amount,
    payment_method: body.payment_method || 'UPI',
    paid_to: String(body.paid_to || '').trim().slice(0, 160),
    spend_type: body.spend_type === 'personal' ? 'personal' : 'business',
    notes: String(body.notes || '').trim().slice(0, 1000),
  }
}
app.get('/api/expenses', auth, permit('expenses'), async (req,res,next)=>{try{
  const rows=await list('expenses',workspaceQuery(req));rows.sort((a,b)=>String(b.expense_date).localeCompare(String(a.expense_date))||Number(b.id||0)-Number(a.id||0));res.json(rows)
}catch(e){next(e)}})
app.post('/api/expenses', auth, permit('expenses', { write: true }), async (req,res,next)=>{try{
  const row=expenseFromBody(req.body);if(!row.amount||!row.description)return res.status(400).json({error:'Description and a valid amount are required.'})
  row.id=await nextId('expenses');row.workspace_id=req.user.workspace_id;row.created_at=now();row.created_by=req.user.user
  await insert('expenses',row);res.status(201).json(row)
}catch(e){next(e)}})
app.delete('/api/expenses/:id', auth, permit('expenses', { write: true }), async (req,res,next)=>{try{
  await remove('expenses',workspaceQuery(req,{id:Number(req.params.id)}));res.status(204).end()
}catch(e){next(e)}})

app.get('/api/notes', auth, permitAny(['notes', 'ai', 'technical']), async (req, res, next) => { try { const rows = await list('work_notes', workspaceQuery(req)); rows.sort((a,b) => String(b.work_date).localeCompare(String(a.work_date))); res.json(rows) } catch (e) { next(e) } })
app.post('/api/notes', auth, permit('notes', { write: true }), async (req, res, next) => { try { const row = { id: await nextId('work_notes'), workspace_id: req.user.workspace_id, work_date: req.body.work_date, note: String(req.body.note || '').trim(), created_at: new Date().toISOString(), created_by: req.user.user }; if (!row.note) return res.status(400).json({ error: 'Note cannot be empty.' }); await insert('work_notes', row); res.json(row) } catch (e) { next(e) } })
app.delete('/api/notes/:id', auth, permit('notes', { write: true }), async (req, res, next) => { try { await remove('work_notes', workspaceQuery(req, { id: Number(req.params.id) })); res.status(204).end() } catch (e) { next(e) } })

app.get('/api/bills', auth, permit('bill'), async (req, res, next) => { try { res.json(await list('bill_history', workspaceQuery(req))) } catch (e) { next(e) } })
app.post('/api/bills', auth, permit('bill', { write: true }), async (req, res, next) => { try { const row = { ...req.body, workspace_id: req.user.workspace_id, bill_id: `BC-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(await nextId('bills')).padStart(4,'0')}`, generated_at: new Date().toISOString(), generated_by: req.user.user }; await insert('bill_history', row); res.json(row) } catch (e) { next(e) } })
app.post('/api/bills/generate', auth, permit('bill', { write: true }), async (req, res, next) => { try {
  const customerName = String(req.body.customer_name || '').trim()
  const scope = ['All Transactions', 'Last Transactions', 'Pending Transactions'].includes(req.body.bill_scope) ? req.body.bill_scope : 'All Transactions'
  const limit = Math.max(1, Math.min(Number(req.body.bill_limit || 5), 100))
  const billDate = String(req.body.bill_date || new Date().toISOString().slice(0, 10))
  let rows = (await list('sales', workspaceQuery(req))).filter((row) => String(row.customer_name || '').toLocaleLowerCase() === customerName.toLocaleLowerCase())
  if (scope === 'Pending Transactions') rows = rows.filter((row) => Number(row.pending_amount || 0) > 0)
  if (scope === 'Last Transactions') rows = rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)) || Number(b.id) - Number(a.id)).slice(0, limit)
  rows.sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)) || Number(a.id) - Number(b.id))
  if (!rows.length) return res.status(400).json({ error: scope === 'Pending Transactions' ? 'No pending transactions found for this customer.' : 'No purchases found for this customer.' })
  const dayKey = billDate.replaceAll('-', '')
  const billId = `BC-${dayKey}-${String(await nextId(`bill_${dayKey}`)).padStart(4, '0')}`
  const scopeLabel = scope === 'Last Transactions' ? `Last ${limit} Transactions` : scope
  const workspace = await one('workspaces', { id: req.user.workspace_id })
  const credits = await list('customer_credits', workspaceQuery(req, { customer_key: usernameKey(customerName) })), storeCredit = credits.reduce((sum,row)=>sum+(row.type==='debit'?-1:1)*Number(row.amount||0),0)
  const generated = await runPython('generate_bill', { sales: rows, customer_name: customerName, bill_id: billId, bill_date: billDate, bill_scope_label: scopeLabel, business_name: workspace?.name || req.user.username, business_logo: workspace?.profile?.logo || '', store_credit: Math.max(0,storeCredit) }, 90000, pythonRequestContext(req))
  const history = {
    bill_id: billId, bill_date: billDate, customer_name: customerName, customer_phone: generated.customer_phone,
    bill_scope: scope, bill_limit: scope === 'Last Transactions' ? limit : null, bill_scope_label: scopeLabel,
    purchase_count: rows.length, purchase_ids: rows.map((row) => Number(row.id)),
    items: rows.map((row) => ({ sale_id: Number(row.id), sale_date: row.sale_date, category: row.product_category || '', description: row.product_description || '', bill_amount: Number(row.selling_price || 0), paid_amount: Number(row.amount_paid || 0), pending_amount: Number(row.pending_amount || 0), paid_date: row.last_payment_date || row.payment_date || '-', status: Number(row.pending_amount || 0) <= 0 ? 'PAID [x]' : 'PENDING' })),
    total_bill: generated.total_bill, total_paid: generated.total_paid, total_pending: generated.total_pending, store_credit: generated.store_credit || 0,
    workspace_id: req.user.workspace_id, business_name: workspace?.name || req.user.username, upi_id: '', generated_at: new Date().toISOString(), generated_by: req.user.user,
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

app.get('/api/devices', auth, permit('security'), async (req, res, next) => { try { res.json(await list('auth_devices', workspaceQuery(req))) } catch (e) { next(e) } })
app.patch('/api/devices/:id', auth, permit('security', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), device = await one('auth_devices', query)
  if (!device) return res.status(404).json({ error: 'Device session not found.' })
  await update('auth_devices', query, { active: Boolean(req.body.active), updated_at: new Date().toISOString() }); res.json({ ok: true })
} catch (e) { next(e) } })
app.put('/api/iam/users/:id/mfa', auth, permit('security', { write: true }), async (req, res, next) => { try {
  const query = workspaceQuery(req, { id: req.params.id }), user = await one('iam_users', query)
  if (!user) return res.status(404).json({ error: 'IAM user not found.' })
  const enabled = req.body.email_otp === true
  if (enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail(user))) return res.status(400).json({ error: 'Add a valid email to this IAM user before enabling email OTP MFA.' })
  const patch = { mfa_email_otp: enabled, mfa_updated_at: now(), mfa_updated_by: req.user.user, updated_at: now() }
  await update('iam_users', query, patch)
  res.json(publicUser({ ...user, ...patch }))
} catch (e) { next(e) } })

app.get('/api/settings', auth, permit('settings'), async (req, res, next) => { try {
  const workspace = await one('workspaces', { id: req.user.workspace_id }), owner = await one('iam_users', { id: workspace?.owner_user_id })
  res.json({ profile: workspace?.profile || owner?.profile || {}, username: owner?.username || req.user.username, workspace_name: workspace?.name || req.user.user, backup_schedule: workspace?.backup_schedule || {} })
} catch (e) { next(e) } })
app.put('/api/settings', auth, permit('settings', { write: true }), async (req, res, next) => { try {
  const workspace = await one('workspaces', { id: req.user.workspace_id })
  if (!workspace) return res.status(404).json({ error: 'Workspace not found.' })
  const requestedUsername=String(req.body.username||req.body.profile?.requested_username||req.user.username).trim(), input=req.body.profile||{}
  if(!/^[A-Za-z0-9._-]{3,50}$/.test(requestedUsername))return res.status(400).json({error:'Username must be 3–50 characters and use only letters, numbers, dots, dashes or underscores.'})
  const profile={...(workspace.profile||{})}
  const limits={full_name:120,email:180,phone:40,organization_name:160,organization_type:100,job_title:100,team_size:30,website:250,city:100,state:100,country:100,use_case:1500,how_heard:200}
  for(const [key,limit] of Object.entries(limits))if(Object.hasOwn(input,key))profile[key]=String(input[key]||'').replace(/\s+/g,' ').trim().slice(0,limit)
  if(Object.hasOwn(input,'logo'))profile.logo=String(input.logo||'').trim()
  if(!profile.organization_name)profile.organization_name=workspace.name||req.user.username
  if(profile.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))return res.status(400).json({error:'Enter a valid business email address.'})
  if(profile.phone){const digits=profile.phone.replace(/\D/g,'');if(digits.length<7||digits.length>16)return res.status(400).json({error:'Enter a valid phone number.'})}
  if(profile.logo&&(!/^data:image\/(png|jpeg|webp);base64,/i.test(profile.logo)||profile.logo.length>1400000))return res.status(400).json({error:'Upload a PNG, JPEG or WebP logo smaller than 1 MB.'})
  const users=await list('iam_users'), reserved=usernameKey(process.env.USERNAME||'Admin')
  const requestedKey=usernameKey(requestedUsername),emailKey=usernameKey(profile.email)
  if(requestedKey===reserved||requestedKey==='admin'||users.some(row=>row.id!==workspace.owner_user_id&&row.username_key===requestedKey))return res.status(409).json({error:'That preferred username is already in use or reserved.'})
  if(emailKey&&users.some(row=>row.id!==workspace.owner_user_id&&usernameKey(row.profile?.email||row.profile?.email_key)===emailKey))return res.status(409).json({error:'That business email is already linked to another account.'})
  profile.email_key=emailKey
  const patch = { name: workspaceName(profile, req.user.username), profile, updated_at: now(), updated_by: req.user.user }
  await update('workspaces', { id: workspace.id }, patch)
  await update('iam_users', { id: workspace.owner_user_id }, { username:requestedUsername, username_key:requestedKey, profile, updated_at: now() })
  res.json({ profile, username:requestedUsername, workspace_name: patch.name, backup_schedule: workspace.backup_schedule || {} })
} catch (e) { next(e) } })
app.post('/api/settings/password', auth, permit('settings', { write: true }), async (req,res,next)=>{try{
  const user=await one('iam_users',{id:req.user.user_id}),password=String(req.body.password||''),confirm=String(req.body.confirm_password||'')
  if(password.length<8||password!==confirm)return res.status(400).json({error:'New passwords must match and contain at least 8 characters.'})
  if(user?.password_hash&&!(await bcrypt.compare(String(req.body.current_password||''),user.password_hash)))return res.status(400).json({error:'Current password is incorrect.'})
  await update('iam_users',{id:user.id},{password_hash:await bcrypt.hash(password,12),password_changed_at:now(),updated_at:now()});res.json({ok:true})
}catch(e){next(e)}})

app.get('/api/gmail/oauth-config',auth,permit('gmail'),async(req,res,next)=>{try{
  const settings=await one('app_settings',{id:`workspace:${req.user.workspace_id}`})
  res.json(publicGmailOAuth(settings?.gmail_oauth,req))
}catch(e){next(e)}})

app.put('/api/gmail/oauth-config',auth,permit('gmail',{write:true}),async(req,res,next)=>{try{
  const id=`workspace:${req.user.workspace_id}`,settings=await one('app_settings',{id}),parsed=gmailOAuthInput(req.body||{},settings?.gmail_oauth||{})
  if(parsed.error)return res.status(400).json({error:parsed.error})
  const gmail_oauth={...parsed.value,updated_at:now(),updated_by:req.user.user},patch={gmail_oauth,updated_at:now(),updated_by:req.user.user}
  if(settings?.gmail?.refresh_token_encrypted&&settings?.gmail_oauth?.client_id&&settings.gmail_oauth.client_id!==gmail_oauth.client_id)patch.gmail=null
  if(settings)await update('app_settings',{id},patch);else await insert('app_settings',{id,workspace_id:req.user.workspace_id,...patch})
  res.json(publicGmailOAuth(gmail_oauth,req))
}catch(e){next(e)}})

app.post('/api/gmail/oauth/start',auth,permit('gmail',{write:true}),async(req,res,next)=>{try{
  const config=await gmailOAuthSettings(req,req.user.workspace_id);if(!config.clientId||!config.clientSecret)return res.status(503).json({error:'Google OAuth is not configured for this workspace. Open Gmail setup and save your Google Client ID and Client Secret first.',redirect_uri:config.redirectUri})
  const state={id:randomUUID(),provider:'gmail',purpose:'gmail_connect',user_id:req.user.user_id,workspace_id:req.user.workspace_id,used:false,created_at:now(),expires_at:new Date(Date.now()+10*60*1000).toISOString()};await insert('oauth_states',state)
  const url=new URL(config.authorizeUrl);url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:config.scope,state:state.id,access_type:'offline',prompt:'consent',include_granted_scopes:'true',login_hint:String(req.body.email||'')}).toString();res.json({url:url.toString(),redirect_uri:config.redirectUri})
}catch(e){next(e)}})

app.get('/api/gmail/oauth/callback',async(req,res)=>{const redirect=new URL(requestOrigin(req));try{
  const state=await consumeTransient('oauth_states',String(req.query.state||''),{provider:'gmail',purpose:'gmail_connect'});if(!state)throw new Error('The Gmail connection request is invalid or expired.');if(req.query.error)throw new Error(String(req.query.error_description||req.query.error))
  const config=await gmailOAuthSettings(req,state.workspace_id);if(!config.clientId||!config.clientSecret)throw new Error('Google OAuth is not configured for this workspace. Save the Gmail setup again and reconnect.')
  const response=await fetch(config.tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId||'',client_secret:config.clientSecret||'',code:String(req.query.code||''),grant_type:'authorization_code',redirect_uri:config.redirectUri})}),token=await response.json().catch(()=>({}));if(!response.ok||!token.access_token)throw new Error(token.error_description||token.error||'Google token exchange failed.')
  const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${token.access_token}`}}),profile=await profileResponse.json().catch(()=>({}));if(!profileResponse.ok||!profile.email)throw new Error('Google did not return the Gmail account email.')
  const id=`workspace:${state.workspace_id}`,settings=await one('app_settings',{id}),old=settings?.gmail||{};if(!token.refresh_token&&!old.refresh_token_encrypted)throw new Error('Google did not return offline access. Reconnect and approve Gmail access.')
  const gmail={email:String(profile.email).toLocaleLowerCase(),name:String(profile.name||''),refresh_token_encrypted:token.refresh_token?encryptSecret(token.refresh_token):old.refresh_token_encrypted,access_token_encrypted:encryptSecret(token.access_token),access_expires_at:new Date(Date.now()+Number(token.expires_in||3600)*1000).toISOString(),scope:String(token.scope||config.scope),connected_at:old.connected_at||now(),updated_at:now(),connected_by:state.user_id}
  if(settings)await update('app_settings',{id},{gmail,updated_at:now()});else await insert('app_settings',{id,workspace_id:state.workspace_id,gmail,updated_at:now()});redirect.searchParams.set('gmail_connected','1')
}catch(error){redirect.searchParams.set('gmail_error',readableError(error,'Gmail connection failed.'))}res.redirect(redirect.toString())})

app.get('/api/gmail/status',auth,permit('gmail'),async(req,res,next)=>{try{const settings=await one('app_settings',{id:`workspace:${req.user.workspace_id}`}),gmail=settings?.gmail;res.json({connected:Boolean(gmail?.refresh_token_encrypted),email:gmail?.email||'',name:gmail?.name||'',connected_at:gmail?.connected_at||''})}catch(e){next(e)}})
app.get('/api/gmail/messages',auth,permit('gmail'),async(req,res,next)=>{try{const max=Math.max(1,Math.min(50,Number(req.query.limit||20))),query=String(req.query.q||'').slice(0,200),params=new URLSearchParams({maxResults:String(max),...(query?{q:query}:{})}),listed=await gmailRequest(req.user.workspace_id,`/messages?${params}`),messages=await Promise.all((listed.messages||[]).map(async item=>{const row=await gmailRequest(req.user.workspace_id,`/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);return{id:row.id,thread_id:row.threadId,snippet:row.snippet||'',from:gmailHeader(row,'From'),to:gmailHeader(row,'To'),subject:gmailHeader(row,'Subject')||'(No subject)',date:gmailHeader(row,'Date'),label_ids:row.labelIds||[]}}));res.json({messages,next_page_token:listed.nextPageToken||''})}catch(e){next(e)}})
app.get('/api/gmail/messages/:id',auth,permit('gmail'),async(req,res,next)=>{try{const row=await gmailRequest(req.user.workspace_id,`/messages/${encodeURIComponent(req.params.id)}?format=full`);res.json({id:row.id,thread_id:row.threadId,from:gmailHeader(row,'From'),to:gmailHeader(row,'To'),subject:gmailHeader(row,'Subject')||'(No subject)',date:gmailHeader(row,'Date'),body:gmailBody(row.payload),snippet:row.snippet||'',label_ids:row.labelIds||[]})}catch(e){next(e)}})
app.post('/api/gmail/send',auth,permit('gmail',{write:true}),async(req,res,next)=>{try{const to=String(req.body.to||'').replace(/[\r\n]/g,'').trim(),subject=String(req.body.subject||'').replace(/[\r\n]/g,' ').trim().slice(0,300),body=String(req.body.body||'').slice(0,100000);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))return res.status(400).json({error:'Enter a valid recipient email.'});if(!body.trim())return res.status(400).json({error:'Write an email message.'});const encodedSubject=/^[\x00-\x7F]*$/.test(subject)?subject:`=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,raw=Buffer.from(`To: ${to}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`).toString('base64url'),sent=await gmailRequest(req.user.workspace_id,'/messages/send',{method:'POST',body:JSON.stringify({raw})});res.json({ok:true,id:sent.id,thread_id:sent.threadId})}catch(e){next(e)}})
app.delete('/api/gmail/connection',auth,permit('gmail',{write:true}),async(req,res,next)=>{try{const id=`workspace:${req.user.workspace_id}`,settings=await one('app_settings',{id}),gmail=settings?.gmail;if(gmail?.refresh_token_encrypted)fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptSecret(gmail.refresh_token_encrypted))}`,{method:'POST'}).catch(()=>{});await update('app_settings',{id},{gmail:null,updated_at:now()});res.status(204).end()}catch(e){next(e)}})

app.get('/api/smtp', auth, permit('smtp'), async (req, res, next) => { try {
  const settings = await one('app_settings', { id: `workspace:${req.user.workspace_id}` })
  res.json(publicSmtp(settings?.smtp))
} catch (e) { next(e) } })
app.put('/api/smtp', auth, permit('smtp', { write: true }), async (req, res, next) => { try {
  const id = `workspace:${req.user.workspace_id}`, settings = await one('app_settings', { id }), parsed = smtpInput(req.body || {}, settings?.smtp || {})
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  const smtp = { ...parsed.value, updated_at: now(), updated_by: req.user.user }
  if (settings) await update('app_settings', { id }, { smtp, updated_at: now(), updated_by: req.user.user })
  else await insert('app_settings', { id, workspace_id: req.user.workspace_id, smtp, updated_at: now(), updated_by: req.user.user })
  res.json(publicSmtp(smtp))
} catch (e) { next(e) } })
app.post('/api/smtp/test', auth, permit('smtp', { write: true }), async (req, res, next) => { try {
  const to = String(req.body.to || '').trim().toLocaleLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid test recipient email address.' })
  const info = await sendConfiguredEmail({
    to, subject: 'Business Manager SMTP test',
    text: `Your platform SMTP connection is working. Test sent by ${req.user.user} at ${now()}.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px"><h2 style="color:#2563eb">SMTP connection successful</h2><p>Your Business Manager workspace can now send email.</p><p style="color:#64748b;font-size:12px">Test sent by ${String(req.user.user).replace(/[<>&"']/g, '')} at ${now()}.</p></div>`,
  }, { allowDisabled: true, workspaceId: req.user.workspace_id })
  res.json({ ok: true, message_id: info.messageId || '', accepted: info.accepted || [] })
} catch (e) { const message = smtpErrorMessage(e); console.error(`SMTP test failed: ${message}`); res.status(400).json({ error: message }) } })

app.get('/api/platform/customers', auth, platformOnly, async (_req, res, next) => { try {
  let users = await list('iam_users')
  for (const user of users.filter((row) => row.source === 'signup' && !row.workspace_id)) await ensureUserWorkspace(user)
  users = await list('iam_users')
  const [workspaces, sales, notes, bills, vendors, devices, signups] = await Promise.all([
    list('workspaces'), list('sales'), list('work_notes'), list('bill_history'), list('passbook_vendors'), list('auth_devices'), list('signup_requests'),
  ])
  const activityDate = (rows) => rows.map((row) => row.last_login_at || row.updated_at || row.generated_at || row.created_at || row.sale_date || '').filter(Boolean).sort().at(-1) || ''
  const customers = workspaces.map((workspace) => {
    const workspaceUsers = users.filter((row) => row.workspace_id === workspace.id)
    const owner = workspaceUsers.find((row) => row.id === workspace.owner_user_id) || workspaceUsers.find((row) => row.role === 'owner') || workspaceUsers[0]
    const workspaceSales = sales.filter((row) => row.workspace_id === workspace.id), workspaceNotes = notes.filter((row) => row.workspace_id === workspace.id)
    const workspaceBills = bills.filter((row) => row.workspace_id === workspace.id), workspaceVendors = vendors.filter((row) => row.workspace_id === workspace.id)
    const workspaceDevices = devices.filter((row) => row.workspace_id === workspace.id), signup = signups.find((row) => row.workspace_id === workspace.id)
    const storageRows = [workspace, ...workspaceUsers, ...workspaceSales, ...workspaceNotes, ...workspaceBills, ...workspaceVendors, ...workspaceDevices, ...(signup ? [signup] : [])]
    const revenue = workspaceSales.reduce((sum, row) => sum + Number(row.selling_price || 0), 0), pending = workspaceSales.reduce((sum, row) => sum + Number(row.pending_amount || 0), 0)
    return {
      id: workspace.id, name: workspace.name, active: workspace.active !== false, plan: workspace.plan || 'free', created_at: workspace.created_at,
      signup_method: workspace.signup_method || owner?.signup_method || signup?.oauth_provider || signup?.signup_method || 'password', profile: workspace.profile || owner?.profile || {},
      owner: owner ? publicUser(owner) : null, team_members: workspaceUsers.length, sales_count: workspaceSales.length,
      customer_count: new Set(workspaceSales.map((row) => String(row.customer_name || '').trim().toLocaleLowerCase()).filter(Boolean)).size,
      revenue, pending, notes_count: workspaceNotes.length, bills_count: workspaceBills.length, vendors_count: workspaceVendors.length,
      login_count: workspaceDevices.length, last_login_at: activityDate(workspaceDevices), last_activity_at: activityDate([...workspaceSales, ...workspaceNotes, ...workspaceBills, ...workspaceDevices, workspace]),
      storage_bytes: storageRows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row || {}), 'utf8'), 0),
    }
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  res.json({
    customers,
    totals: {
      workspaces: customers.length, active: customers.filter((row) => row.active).length,
      users: customers.reduce((sum, row) => sum + row.team_members, 0), sales: customers.reduce((sum, row) => sum + row.sales_count, 0),
      revenue: customers.reduce((sum, row) => sum + row.revenue, 0), storage_bytes: customers.reduce((sum, row) => sum + row.storage_bytes, 0),
    },
  })
} catch (e) { next(e) } })

app.patch('/api/platform/customers/:id', auth, platformOnly, async (req, res, next) => { try {
  const workspace = await one('workspaces', { id: req.params.id })
  if (!workspace) return res.status(404).json({ error: 'Customer workspace not found.' })
  const active = req.body.active === undefined ? workspace.active !== false : Boolean(req.body.active)
  const patch = { active, updated_at: now(), updated_by: req.user.user }
  await update('workspaces', { id: workspace.id }, patch)
  res.json({ ...workspace, ...patch })
} catch (e) { next(e) } })

app.get('/api/backup', auth, permit('backup'), async (req, res, next) => { try {
  const data = {}; for (const name of BUSINESS_COLLECTIONS) data[name] = await list(name, workspaceQuery(req))
  const workspace = await one('workspaces', { id: req.user.workspace_id })
  res.setHeader('Content-Disposition', `attachment; filename="business-backup-${new Date().toISOString().slice(0,10)}.json"`)
  res.json({ version: 6, created_at: new Date().toISOString(), workspace: { id: req.user.workspace_id, name: workspace?.name || req.user.user }, data })
} catch (e) { next(e) } })
app.post('/api/restore', auth, permit('backup', { write: true }), async (req, res, next) => { try {
  const data = req.body.data || {}; let inserted = 0, skipped = 0
  for (const name of BUSINESS_COLLECTIONS) for (const source of (data[name] || [])) {
    const row = { ...clean(source), workspace_id: req.user.workspace_id }, query = row.id !== undefined ? workspaceQuery(req, { id: row.id }) : row.bill_id ? workspaceQuery(req, { bill_id: row.bill_id }) : row.key ? workspaceQuery(req, { key: row.key }) : workspaceQuery(req, { restore_hash: createHash('sha256').update(JSON.stringify(source)).digest('hex') })
    if (await one(name, query)) { skipped++; continue }
    if (!row.id && !row.bill_id && !row.key) row.restore_hash = query.restore_hash
    await insert(name, row); inserted++
  }
  res.json({ inserted, skipped })
} catch (e) { next(e) } })

async function workspaceBackup(workspaceId) {
  const data = {}; for (const name of BUSINESS_COLLECTIONS) data[name] = await list(name, { workspace_id: workspaceId })
  const workspace = await one('workspaces', { id: workspaceId })
  return { version: 6, created_at: now(), workspace: { id: workspaceId, name: workspace?.name || 'Business workspace' }, data }
}

app.get('/api/backup/schedule', auth, permit('backup'), async (req, res, next) => { try {
  const workspace = await one('workspaces', { id: req.user.workspace_id }); res.json(workspace?.backup_schedule || { enabled:false, interval_hours:24, email:'', only_if_changed:true })
} catch (e) { next(e) } })
app.put('/api/backup/schedule', auth, permit('backup', { write: true }), async (req, res, next) => { try {
  const email = String(req.body.email || '').trim().toLocaleLowerCase(), interval = Math.max(24, Math.min(720, Number(req.body.interval_hours || 24)))
  if (req.body.enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid backup recipient email.' })
  const workspace = await one('workspaces', { id: req.user.workspace_id }), schedule = { ...(workspace?.backup_schedule || {}), enabled:Boolean(req.body.enabled), email, interval_hours:interval, only_if_changed:req.body.only_if_changed !== false, updated_at:now(), updated_by:req.user.user }
  await update('workspaces', { id:req.user.workspace_id }, { backup_schedule:schedule, updated_at:now() }); res.json(schedule)
} catch (e) { next(e) } })

app.get('/api/cron/backups', async (req, res, next) => { try {
  const secret = String(process.env.CRON_SECRET || ''), authorization = String(req.headers.authorization || '')
  if (!secret || authorization !== `Bearer ${secret}`) return res.status(401).json({ error:'Invalid scheduler authorization.' })
  const workspaces = (await list('workspaces')).filter((row) => row.active !== false && row.backup_schedule?.enabled), results=[]
  for (const workspace of workspaces) {
    const schedule=workspace.backup_schedule, due=!schedule.last_sent_at || Date.now()-Date.parse(schedule.last_sent_at)>=Number(schedule.interval_hours||24)*3600000
    if (!due) continue
    const backup=await workspaceBackup(workspace.id), content=JSON.stringify(backup,null,2), hash=createHash('sha256').update(content.replace(/"created_at":\s*"[^"]+"/,'"created_at":""')).digest('hex')
    if (schedule.only_if_changed && schedule.last_content_hash===hash) { results.push({workspace_id:workspace.id,status:'unchanged'}); continue }
    try {
      await sendConfiguredEmail({to:schedule.email,subject:`${workspace.name} backup · ${backup.created_at.slice(0,10)}`,text:'Your scheduled Business Manager JSON recovery backup is attached.',html:`<p>Your scheduled <strong>${String(workspace.name).replace(/[<>&"']/g,'')}</strong> recovery backup is attached.</p>`,attachments:[{filename:`business-backup-${backup.created_at.slice(0,10)}.json`,content}]},{workspaceId:workspace.id})
      await update('workspaces',{id:workspace.id},{backup_schedule:{...schedule,last_sent_at:now(),last_content_hash:hash,last_status:'sent'}}); results.push({workspace_id:workspace.id,status:'sent'})
    } catch(error) { await update('workspaces',{id:workspace.id},{backup_schedule:{...schedule,last_attempt_at:now(),last_status:readableError(error)}}); results.push({workspace_id:workspace.id,status:'failed'}) }
  }
  res.json({ok:true,processed:results.length,results})
} catch(e){next(e)} })

app.post('/api/passbook/parse', auth, permit('passbook', { write: true }), upload.array('files', 10), async (req, res, next) => { try {
  if (!req.files?.length) return res.status(400).json({ error: 'Choose one or more PDF files.' })
  const files = req.files.map((file) => ({ filename: file.originalname, base64: file.buffer.toString('base64') }))
  res.json(await runPython('parse_passbooks', { files }, 90000, pythonRequestContext(req)))
} catch (e) { next(e) } })
app.get('/api/passbook/vendors', auth, permit('passbook'), async (req, res, next) => { try {
  const rows = await list('passbook_vendors', workspaceQuery(req)); res.json(rows.map((row) => row.name).filter(Boolean).sort((a, b) => a.localeCompare(b)))
} catch (e) { next(e) } })
app.post('/api/passbook/vendors', auth, permit('passbook', { write: true }), async (req, res, next) => { try {
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim(), key = name.toLocaleLowerCase()
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' })
  const query = workspaceQuery(req, { key }), existing = await one('passbook_vendors', query)
  const row = { key, name, workspace_id: req.user.workspace_id, updated_at: new Date().toISOString(), updated_by: req.user.user }
  existing ? await update('passbook_vendors', query, row) : await insert('passbook_vendors', { ...row, created_at: new Date().toISOString() })
  res.json(row)
} catch (e) { next(e) } })
app.delete('/api/passbook/vendors/:name', auth, permit('passbook', { write: true }), async (req, res, next) => { try {
  await remove('passbook_vendors', workspaceQuery(req, { key: decodeURIComponent(req.params.name).toLocaleLowerCase() })); res.status(204).end()
} catch (e) { next(e) } })

async function askAI(question, context) {
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase()
  if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: `You are a concise business finance assistant.\n\nCONTEXT:\n${context}\n\nTASK:\n${question}` }] }] }) })
    const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || 'Gemini request failed')
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || 'No response.'
  }
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: 'You are a concise business finance assistant.' }, { role: 'user', content: `CONTEXT:\n${context}\n\nTASK:\n${question}` }] }) })
    const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || 'OpenAI request failed')
    return json.choices?.[0]?.message?.content || 'No response.'
  }
  throw new Error('Configure GEMINI_API_KEY or OPENAI_API_KEY on the server.')
}
app.post('/api/ai', auth, permit('ai'), async (req, res, next) => { try {
  const sales = (await list('sales', workspaceQuery(req))).slice(-150), notes = (await list('work_notes', workspaceQuery(req))).slice(-30), expenses = (await list('expenses', workspaceQuery(req))).slice(-150)
  const context = JSON.stringify({ sales, expenses, notes }).slice(0, 80000)
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
