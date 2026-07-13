import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArchiveRestore, BarChart3, BookOpen, Bot, Building2, CheckCircle2, ChevronLeft,
  ChevronRight, CircleDollarSign, ClipboardList, CloudDownload, Database, FileSearch, FileText, Gauge, Globe2,
  Eye, Fingerprint, Home, IndianRupee, KeyRound, Layers3, LockKeyhole, LogIn, LogOut, Mail, MapPin, Menu, Moon, NotebookPen, PencilLine, Phone, Plus,
  ReceiptText, RefreshCw, Rocket, Search, Send, Settings, ShieldCheck, ShoppingBag, Sparkles, Store, Sun, Trash2,
  TrendingUp, Upload, UserCog, UserPlus, UserRound, UsersRound, WalletCards, Workflow, X,
} from 'lucide-react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { format, parseISO, differenceInDays } from 'date-fns'
import writeXlsxFile from 'write-excel-file'

const CATEGORIES = ['Sarees', 'Salwar Suits', 'Lehengas', 'Kurtis', 'Western Wear', 'Accessories', 'Kids Wear', 'Blouse', 'Fabric', 'Other']
const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Part Payment', 'Credit']
const COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0ea5e9', '#8b5cf6']
const today = () => new Date().toISOString().slice(0, 10)
const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const dateLabel = (value) => { try { return format(parseISO(String(value).slice(0, 10)), 'dd MMM yyyy') } catch { return value || '—' } }

const NAV = [
  ['dashboard', 'Overview', Home], ['add-sale', 'Add sale', Plus], ['review', 'Review accounts', ClipboardList],
  ['update', 'Update transaction', PencilLine], ['customers', 'Customers', UsersRound], ['vendors', 'Vendors', ShoppingBag],
  ['analytics', 'Analytics', BarChart3], ['reminders', 'Reminders', AlertTriangle], ['bill', 'Generate bill', ReceiptText],
  ['passbook', 'Passbook reader', FileSearch], ['notes', 'Work notes', NotebookPen],
  ['ai', 'AI assistant', Sparkles], ['technical', 'Technical', Database], ['iam', 'IAM', UserCog], ['security', 'Security & devices', ShieldCheck],
  ['backup', 'Backup & restore', ArchiveRestore],
]
const FEATURE_OPTIONS = NAV.filter(([id]) => !['iam', 'security', 'backup'].includes(id)).map(([id, label]) => ({ id, label }))
const VIEWER_FEATURES = ['dashboard', 'review', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'notes', 'ai']
const ROLE_LABELS = { admin: 'Administrator', custom: 'Custom access', viewer: 'Viewer · read only' }

async function request(path, options = {}) {
  const token = localStorage.getItem('boutique_token')
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 15000)
  let response
  try {
    response = await fetch(`/api${path}`, { ...options, headers, signal: controller.signal })
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The API did not respond. Make sure npm run dev is still running, then try again.')
    throw new Error('Cannot reach the boutique API. Start the app with npm run dev and try again.')
  } finally {
    window.clearTimeout(timeout)
  }
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(formatError(data.error || data, 'Request failed.'))
  return data
}

function formatError(value, fallback = 'Request failed.') {
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

function Button({ children, variant = 'primary', icon: Icon, className = '', ...props }) {
  return <button className={`button ${variant} ${className}`} {...props}>{Icon && <Icon size={17} />}{children}</button>
}
function PageHead({ title, eyebrow, action }) {
  return <header className="page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>{action}</header>
}
function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section> }
function Empty({ icon: Icon = ArchiveRestore, title = 'Nothing here yet', copy = 'New records will appear here.' }) {
  return <div className="empty"><span><Icon size={26} /></span><h3>{title}</h3><p>{copy}</p></div>
}
function Field({ label, as = 'input', children, ...props }) {
  const Tag = as
  return <label className="field"><span>{label}</span><Tag {...props}>{children}</Tag></label>
}
function Metric({ label, value, hint, icon: Icon, tone = 'blue' }) {
  return <Card className={`metric ${tone}`}><div className="metric-icon">{Icon && <Icon size={19} />}</div><div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div></Card>
}
function Status({ paid, delayed }) {
  if (delayed) return <span className="badge red">Delayed</span>
  return paid ? <span className="badge green">Received</span> : <span className="badge amber">Pending</span>
}
function Notice({ value, clear }) { return value ? <div className={`notice ${value.type || 'success'}`}>{value.text}<button onClick={clear}><X size={16} /></button></div> : null }

const blankSale = () => ({ customer_name: '', customer_phone: '', sale_date: today(), vendor: '', product_category: 'Sarees', product_description: '', buying_price: '', selling_price: '', amount_paid: '', payment_method: 'UPI', delay_status: false, notes: '' })

function SaleForm({ initial, onSave, submitLabel = 'Save sale', customerSales = [] }) {
  const [form, setForm] = useState(initial || blankSale())
  const [busy, setBusy] = useState(false)
  const [customerMode, setCustomerMode] = useState('existing')
  const customerOptions = useMemo(() => {
    const customers = new Map()
    ;[...customerSales]
      .sort((a, b) => String(b.sale_date || '').localeCompare(String(a.sale_date || '')) || Number(b.id || 0) - Number(a.id || 0))
      .forEach((sale) => {
        const name = String(sale.customer_name || '').trim(), key = name.toLocaleLowerCase(), phone = String(sale.customer_phone || '').trim()
        if (name && !customers.has(key)) customers.set(key, { name, phone })
        else if (name && phone && !customers.get(key).phone) customers.get(key).phone = phone
      })
    return [...customers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [customerSales])
  const canChooseExisting = !initial && customerOptions.length > 0
  const choosingExisting = canChooseExisting && customerMode === 'existing'
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }))
  const changeCustomerMode = (mode) => {
    setCustomerMode(mode)
    setForm((old) => ({ ...old, customer_name: '', customer_phone: '' }))
  }
  const chooseCustomer = (name) => {
    const customer = customerOptions.find((item) => item.name === name)
    setForm((old) => ({ ...old, customer_name: name, customer_phone: customer?.phone || '' }))
  }
  const pending = Math.max(0, Number(form.selling_price || 0) - Number(form.amount_paid || 0))
  async function submit(e) {
    e.preventDefault(); setBusy(true)
    try { await onSave(form); if (!initial) setForm(blankSale()) } finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="sale-form">
    <div className="form-section"><div className="section-title"><UserRound size={18} /><div><h3>Customer</h3><p>Contact and transaction date</p></div></div>
      {canChooseExisting && <div className="customer-mode sale-customer-mode"><div><span>Customer type</span><small>Select an existing customer to add another order to their account.</small></div><div className="segmented"><button type="button" data-testid="existing-customer-mode" className={customerMode === 'existing' ? 'active' : ''} onClick={() => changeCustomerMode('existing')}>Existing customer</button><button type="button" data-testid="new-customer-mode" className={customerMode === 'new' ? 'active' : ''} onClick={() => changeCustomerMode('new')}>New customer</button></div></div>}
      <div className="form-grid three">{choosingExisting ? <Field label="Existing customer" as="select" data-testid="existing-customer-select" value={form.customer_name} onChange={(e) => chooseCustomer(e.target.value)} required><option value="">Choose a customer…</option>{customerOptions.map((customer) => <option value={customer.name} key={customer.name}>{customer.name}{customer.phone ? ` — ${customer.phone}` : ''}</option>)}</Field> : <Field label="Customer name" data-testid="new-customer-name" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} required />}<Field label="Phone number" data-testid="sale-phone" value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder={choosingExisting ? 'Auto-filled from customer' : ''} /><Field label="Sale date" type="date" value={form.sale_date} onChange={(e) => set('sale_date', e.target.value)} required /></div>
    </div>
    <div className="form-section"><div className="section-title"><ShoppingBag size={18} /><div><h3>Item details</h3><p>Product, category and sourcing</p></div></div>
      <div className="form-grid three"><Field label="Category" as="select" value={form.product_category} onChange={(e) => set('product_category', e.target.value)}>{CATEGORIES.map((x) => <option key={x}>{x}</option>)}</Field><Field label="Vendor" value={form.vendor} onChange={(e) => set('vendor', e.target.value)} /><Field label="Description" value={form.product_description} onChange={(e) => set('product_description', e.target.value)} /></div>
    </div>
    <div className="form-section"><div className="section-title"><IndianRupee size={18} /><div><h3>Payment</h3><p>Pricing and collection status</p></div></div>
      <div className="form-grid four"><Field label="Buying price" type="number" min="0" step="0.01" value={form.buying_price} onChange={(e) => set('buying_price', e.target.value)} /><Field label="Selling price" type="number" min="0" step="0.01" value={form.selling_price} onChange={(e) => set('selling_price', e.target.value)} required /><Field label="Amount paid" type="number" min="0" step="0.01" value={form.amount_paid} onChange={(e) => set('amount_paid', e.target.value)} /><Field label="Method" as="select" value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>{PAYMENT_METHODS.map((x) => <option key={x}>{x}</option>)}</Field></div>
      <div className="amount-preview"><span>Pending after this sale</span><strong>{money(pending)}</strong></div>
    </div>
    <Field label="Notes" as="textarea" rows="3" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Alterations, delivery details, colour, size…" />
    <div className="form-actions"><Button type="submit" icon={busy ? RefreshCw : Plus} disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button></div>
  </form>
}

const LANDING_FEATURES = [
  [ShoppingBag, 'Sales workspace', 'Record new and repeat customer orders with payment, vendor and product details.'],
  [WalletCards, 'Accounts & collections', 'Review balances, record collections and follow up on delayed or high-value payments.'],
  [ReceiptText, 'Professional bills', 'Generate customer PDF statements with permanent bill history and transaction snapshots.'],
  [FileSearch, 'Passbook reader', 'Use the Python-powered extractor to read transaction PDFs and convert selected rows into sales.'],
  [BarChart3, 'Business analytics', 'Understand revenue, profit, customers, categories, payment methods and vendor performance.'],
  [UserCog, 'IAM & secure login', 'Control admin, custom and viewer access, revoke sessions and use locally generated PEM credentials.'],
  [Bot, 'AI assistant', 'Ask questions about accounts, collections, vendors, work notes and daily priorities.'],
  [ArchiveRestore, 'Protected backups', 'Administrators can export and restore application data with a controlled backup workflow.'],
]

function PublicHome({ onLogin }) {
  const [loginOpen, setLoginOpen] = useState(false), [signupOpen, setSignupOpen] = useState(false), [oauthContext, setOauthContext] = useState(null), [notice, setNotice] = useState(null)
  const openSignup = () => { setOauthContext(null); setLoginOpen(false); setSignupOpen(true) }
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search),ticket=params.get('oauth_ticket'),signupTicket=params.get('oauth_signup_ticket'),oauthError=params.get('oauth_error')
    if(!ticket&&!signupTicket&&!oauthError)return
    window.history.replaceState({},'',window.location.pathname)
    if(oauthError){setNotice({type:'error',text:oauthError});setLoginOpen(true);return}
    if(signupTicket){request('/auth/oauth/signup-context',{method:'POST',body:JSON.stringify({ticket:signupTicket})}).then((context)=>{setOauthContext({...context,ticket:signupTicket});setLoginOpen(false);setSignupOpen(true)}).catch((error)=>{setNotice({type:'error',text:error.message});setLoginOpen(true)});return}
    request('/auth/oauth/exchange',{method:'POST',body:JSON.stringify({ticket})}).then((data)=>{localStorage.setItem('boutique_token',data.token);localStorage.setItem('boutique_user',JSON.stringify(data.user));onLogin(data.user)}).catch((error)=>{setNotice({type:'error',text:error.message});setLoginOpen(true)})
  },[onLogin])
  return <main className="public-page landing-page">
    <header className="public-nav landing-nav"><a className="brand-lockup" href="#top"><img src="/krishna_symbol.png" onError={(e) => { e.currentTarget.style.display = 'none' }} /><div><strong>Shree Krishna</strong><span>Boutique manager</span></div></a><nav><a href="#features">Features</a><a href="#platform">Technology</a><a href="#security">Security</a></nav><div className="landing-auth"><Button variant="ghost" icon={LogIn} onClick={() => setLoginOpen(true)}>Log in</Button><Button icon={UserPlus} onClick={openSignup}>Sign up</Button></div></header>
    <div className="landing-notice"><Notice value={notice} clear={()=>setNotice(null)}/></div>
    <section className="landing-hero" id="top"><div className="landing-copy"><span className="landing-kicker"><Sparkles/>A complete boutique operations workspace</span><h1>Run every boutique account from <em>one calm workspace.</em></h1><p>Manage sales, customers, collections, bills, passbook records, vendors, analytics and team access without scattered spreadsheets or manual follow-ups.</p><div className="landing-actions"><Button icon={Rocket} onClick={openSignup}>Request your workspace</Button><Button variant="secondary" icon={LogIn} onClick={() => setLoginOpen(true)}>Team login</Button></div><div className="landing-trust"><span><CheckCircle2/>Role-based access</span><span><CheckCircle2/>MongoDB records</span><span><CheckCircle2/>PEM authentication</span></div></div><div className="product-window"><div className="product-window-top"><div><span/><span/><span/></div><small>Business overview</small><span className="badge green">Live workspace</span></div><div className="product-metrics"><div><span>Revenue</span><strong>₹56,395</strong><small>Sales performance</small></div><div><span>Pending</span><strong>₹41,486</strong><small>Collection queue</small></div><div><span>Customers</span><strong>128</strong><small>Relationship records</small></div></div><div className="product-body"><div className="product-chart"><div className="chart-heading"><span>Monthly revenue</span><small>Revenue · Profit</small></div><div className="chart-bars">{[38,62,48,82,57,74,92,68].map((height,index)=><i key={index} style={{height:`${height}%`}}/>)}</div></div><div className="product-activity"><span>Today’s priorities</span>{[['Collect pending payment','₹8,500'],['Generate customer bill','PDF'],['Review passbook entries','12 rows']].map(([label,value])=><div key={label}><i/><p>{label}<small>Ready for action</small></p><strong>{value}</strong></div>)}</div></div></div></section>
    <section className="landing-section feature-section" id="features"><div className="landing-heading"><span className="eyebrow">Everything in one place</span><h2>Built around the way a boutique actually works.</h2><p>Each area is connected to the same protected business data, so your team can move from a sale to collection, billing and reporting without re-entering information.</p></div><div className="feature-grid">{LANDING_FEATURES.map(([Icon,title,copy],index)=><article key={title}><span className={`feature-icon tone-${index%4}`}><Icon/></span><h3>{title}</h3><p>{copy}</p><small>{String(index+1).padStart(2,'0')}</small></article>)}</div></section>
    <section className="landing-section platform-section" id="platform"><div className="platform-copy"><span className="eyebrow">Modern technology</span><h2>Fast in the browser. Powerful behind the scenes.</h2><p>The interface is designed for daily business use while dedicated backend services handle authentication, MongoDB persistence and document processing.</p><div className="platform-points"><div><Gauge/><span><strong>React interface</strong><small>Responsive dashboards and workflows for desktop or mobile.</small></span></div><div><Database/><span><strong>MongoDB data layer</strong><small>Persistent sales, bills, IAM, security and registration records.</small></span></div><div><Workflow/><span><strong>Express API</strong><small>Central validation, role enforcement and business operations.</small></span></div><div><Layers3/><span><strong>Python document tools</strong><small>Passbook extraction and downloadable PDF bill generation.</small></span></div></div></div><div className="platform-stack"><span className="stack-orbit orbit-one">React</span><span className="stack-orbit orbit-two">MongoDB</span><span className="stack-orbit orbit-three">Python</span><span className="stack-orbit orbit-four">Vercel</span><div><Globe2/><strong>One connected platform</strong><small>Securely available wherever your team works.</small></div></div></section>
    <section className="landing-section security-section" id="security"><div className="security-showcase"><span><ShieldCheck/></span><div><span className="eyebrow">Security by design</span><h2>Give every person exactly the access they need.</h2><p>Administrators manage users and sessions, custom roles receive selected features, and viewers remain read-only. PEM sign-in uses one-time challenges while the private key stays on the user’s device.</p></div></div><div className="security-cards"><article><UserCog/><strong>Admin</strong><p>Full application, IAM and security control.</p></article><article><Settings/><strong>Custom access</strong><p>Only administrator-selected business features.</p></article><article><Eye/><strong>Viewer</strong><p>Protected read-only access with server-side enforcement.</p></article></div></section>
    <section className="landing-cta"><span className="eyebrow">Ready to get organised?</span><h2>Bring your boutique operations into one workspace.</h2><p>Send your business details and an administrator will review your access request.</p><div><Button icon={UserPlus} onClick={openSignup}>Create access request</Button><Button variant="ghost" onClick={() => setLoginOpen(true)}>Already registered? Log in</Button></div></section>
    <footer className="landing-footer"><div className="brand-lockup"><img src="/krishna_symbol.png" onError={(e) => { e.currentTarget.style.display = 'none' }} /><div><strong>Shree Krishna</strong><span>Boutique manager</span></div></div><p>Sales, accounts, billing and secure team access in one connected workspace.</p><span>React · Express · MongoDB · Python</span></footer>
    {loginOpen && <LoginModal close={() => setLoginOpen(false)} onLogin={onLogin} />}
    {signupOpen && <SignupModal oauthContext={oauthContext} close={() => { setSignupOpen(false); setOauthContext(null) }} openLogin={() => { setSignupOpen(false); setOauthContext(null); setLoginOpen(true) }} />}
  </main>
}

const blankSignup = () => ({ full_name:'',email:'',phone:'',organization_name:'',organization_type:'Boutique / Fashion retail',job_title:'',team_size:'1–5',website:'',city:'',state:'',country:'India',requested_username:'',password:'',confirm_password:'',use_case:'',how_heard:'',terms:false })
function SignupModal({ close, openLogin, oauthContext }) {
  const [form,setForm]=useState(()=>({...blankSignup(),full_name:oauthContext?.name||'',email:oauthContext?.email||'',requested_username:oauthContext?.suggested_username||''})),[busy,setBusy]=useState(false),[error,setError]=useState(''),[complete,setComplete]=useState(false)
  const set=(key,value)=>setForm((old)=>({...old,[key]:value}))
  async function submit(e){e.preventDefault();setError('');if(!oauthContext&&form.password!==form.confirm_password)return setError('Passwords do not match.');if(!form.terms)return setError('Please confirm the information and access terms.');setBusy(true);try{const path=oauthContext?'/auth/signup/oauth/complete':'/auth/signup',body=oauthContext?{...form,oauth_ticket:oauthContext.ticket}:form;await request(path,{method:'POST',body:JSON.stringify(body)});setComplete(true)}catch(e){setError(e.message)}finally{setBusy(false)}}
  function socialSignup(provider){window.location.assign(`/api/auth/oauth/${provider}/start?intent=continue`)}
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal signup-modal" onMouseDown={(e)=>e.stopPropagation()}>
      <button className="modal-close" onClick={close}><X/></button>
      {complete ? <div className="signup-complete">
        <span><CheckCircle2/></span><span className="eyebrow">Request received</span>
        <h2>Thank you, {form.full_name.split(' ')[0]}.</h2>
        <p>Your organisation and account details are saved securely. An administrator must approve the request before you can log in.</p>
        <div><Button icon={LogIn} onClick={openLogin}>Go to login</Button><Button variant="ghost" onClick={close}>Close</Button></div>
      </div> : <>
        <div className="signup-head"><span className="login-mark"><Building2/></span><div><span className="eyebrow">Workspace registration</span><h2>{oauthContext ? 'A few details before we create your request.' : 'Tell us about you and your organisation.'}</h2><p>{oauthContext ? `Your ${oauthContext.provider} identity is verified. Complete the remaining questions for administrator approval.` : 'Continue with Google or Microsoft first, or complete the form with a workspace password.'}</p></div></div>
        {oauthContext ? <div className="oauth-connected"><span className={oauthContext.provider === 'google' ? 'oauth-google' : 'oauth-microsoft'}>{oauthContext.provider === 'google' ? 'G' : <><i/><i/><i/><i/></>}</span><div><strong>{oauthContext.email}</strong><small>Verified with {oauthContext.provider}. No additional password is required.</small></div><CheckCircle2/></div> : <div className="signup-first"><div><strong>Continue with an existing identity</strong><small>We will sign you in if your account is approved, or bring you back here with your name and email already verified.</small></div><div className="oauth-buttons"><button type="button" onClick={()=>socialSignup('google')}><span className="oauth-google">G</span>Continue with Google</button><button type="button" onClick={()=>socialSignup('microsoft')}><span className="oauth-microsoft"><i/><i/><i/><i/></span>Continue with Microsoft</button></div><div className="auth-divider"><span>or answer below and create a password</span></div></div>}
        <form onSubmit={submit}>
          <div className="signup-section">
            <h3><UserRound/>Contact details</h3>
            <div className="form-grid three">
              <Field label="Full name" value={form.full_name} onChange={(e)=>set('full_name',e.target.value)} required/>
              <Field label={oauthContext ? 'Verified business email' : 'Business email'} type="email" value={form.email} disabled={Boolean(oauthContext)} onChange={(e)=>set('email',e.target.value)} required/>
              <Field label="Phone number" type="tel" value={form.phone} onChange={(e)=>set('phone',e.target.value)} required/>
              <Field label="Job title / role" value={form.job_title} onChange={(e)=>set('job_title',e.target.value)} placeholder="Owner, accountant, manager…"/>
              <Field label="Preferred username" value={form.requested_username} onChange={(e)=>set('requested_username',e.target.value)} minLength="3" required/>
              <Field label="How did you hear about us?" value={form.how_heard} onChange={(e)=>set('how_heard',e.target.value)}/>
            </div>
          </div>
          <div className="signup-section">
            <h3><Store/>Organisation details</h3>
            <div className="form-grid three">
              <Field label="Organisation name" value={form.organization_name} onChange={(e)=>set('organization_name',e.target.value)} required/>
              <Field label="Organisation type" as="select" value={form.organization_type} onChange={(e)=>set('organization_type',e.target.value)}><option>Boutique / Fashion retail</option><option>Designer studio</option><option>Tailoring / Alterations</option><option>Wholesale / Distribution</option><option>Multi-store retail</option><option>Independent professional</option><option>Other</option></Field>
              <Field label="Team size" as="select" value={form.team_size} onChange={(e)=>set('team_size',e.target.value)}><option>1–5</option><option>6–15</option><option>16–50</option><option>51–100</option><option>100+</option></Field>
              <Field label="Website / social page" type="url" value={form.website} onChange={(e)=>set('website',e.target.value)} placeholder="https://"/>
              <Field label="City" value={form.city} onChange={(e)=>set('city',e.target.value)} required/>
              <Field label="State" value={form.state} onChange={(e)=>set('state',e.target.value)} required/>
              <Field label="Country" value={form.country} onChange={(e)=>set('country',e.target.value)} required/>
            </div>
            <Field label="What would you like to manage?" as="textarea" rows="3" value={form.use_case} onChange={(e)=>set('use_case',e.target.value)} placeholder="Sales, collections, billing, passbook entries, reporting…"/>
          </div>
          <div className="signup-section">
            <h3><LockKeyhole/>Account security</h3>
            {oauthContext ? <div className="social-security-note"><ShieldCheck/><span><strong>Provider-protected account</strong><small>You will use Continue with {oauthContext.provider} after your request is approved.</small></span></div> : <div className="form-grid two"><Field label="Password" type="password" minLength="8" value={form.password} onChange={(e)=>set('password',e.target.value)} required/><Field label="Confirm password" type="password" minLength="8" value={form.confirm_password} onChange={(e)=>set('confirm_password',e.target.value)} required/></div>}
            <label className="signup-consent"><input type="checkbox" checked={form.terms} onChange={(e)=>set('terms',e.target.checked)}/><span>I confirm these details are correct and understand that access requires administrator approval.</span></label>
          </div>
          {error&&<p className="form-error">{error}</p>}
          <div className="signup-actions"><p><ShieldCheck/>{oauthContext ? 'Your verified identity will be linked only after approval.' : 'Passwords are hashed before storage.'}</p><Button icon={UserPlus} disabled={busy}>{busy?'Submitting request…':'Submit access request'}</Button></div>
        </form>
      </>}
    </div>
  </div>
}

function pemBytes(pem) {
  const match = String(pem).match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/)
  if (!match) throw new Error('Use an unencrypted PKCS#8 private PEM file (BEGIN PRIVATE KEY).')
  const binary = atob(match[1].replace(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
function bytesBase64(bytes) {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(binary)
}
function pemFromDer(bytes, label) {
  const lines = bytesBase64(bytes).match(/.{1,64}/g) || []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}
function downloadTextFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-pem-file' })), link = document.createElement('a')
  link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function signPemChallenge(file, challenge) {
  const privateKey = await window.crypto.subtle.importKey('pkcs8', pemBytes(await file.text()), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const challengeBytes = Uint8Array.from(atob(challenge), (character) => character.charCodeAt(0))
  return bytesBase64(await window.crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, challengeBytes))
}

function LoginModal({ close, onLogin }) {
  const [form, setForm] = useState({ username: 'admin', password: '' }), [mode, setMode] = useState('password'), [pemFile, setPemFile] = useState(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  function finish(data) { localStorage.setItem('boutique_token', data.token); localStorage.setItem('boutique_user', JSON.stringify(data.user)); onLogin(data.user) }
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      if (mode === 'password') finish(await request('/auth/login', { method: 'POST', body: JSON.stringify(form) }))
      else {
        if (!pemFile) throw new Error('Choose your private PEM file.')
        const challenge = await request('/auth/pem/challenge', { method: 'POST', body: JSON.stringify({ username: form.username }) })
        const signature = await signPemChallenge(pemFile, challenge.challenge)
        finish(await request('/auth/pem/login', { method: 'POST', body: JSON.stringify({ username: form.username, challenge_id: challenge.challenge_id, signature }) }))
      }
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal login-modal" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={close}><X /></button><span className="login-mark">{mode === 'password' ? <ShieldCheck /> : <Fingerprint />}</span><span className="eyebrow">Protected workspace</span><h2>Welcome back</h2><p>Continue with a provider to sign in, or begin a signup if you are new.</p><div className="oauth-buttons"><button type="button" onClick={()=>window.location.assign('/api/auth/oauth/google/start?intent=continue')}><span className="oauth-google">G</span>Continue with Google</button><button type="button" onClick={()=>window.location.assign('/api/auth/oauth/microsoft/start?intent=continue')}><span className="oauth-microsoft"><i/><i/><i/><i/></span>Continue with Microsoft</button></div><div className="auth-divider"><span>or use workspace credentials</span></div><div className="login-tabs"><button className={mode === 'password' ? 'active' : ''} onClick={() => { setMode('password'); setError('') }}><LockKeyhole />Password</button><button className={mode === 'pem' ? 'active' : ''} onClick={() => { setMode('pem'); setError('') }}><KeyRound />PEM file</button></div><form onSubmit={submit}><Field label="Username" autoFocus value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />{mode === 'password' ? <Field label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /> : <label className="pem-picker"><span>Private PEM file</span><input type="file" accept=".pem,.key,application/x-pem-file" onChange={(e) => setPemFile(e.target.files[0] || null)} /><small>{pemFile ? pemFile.name : 'Choose an unencrypted PKCS#8 private key. It never leaves this browser.'}</small></label>}{error && <p className="form-error">{error}</p>}<Button type="submit" disabled={busy} icon={mode === 'password' ? LogIn : Fingerprint}>{busy ? 'Signing in…' : mode === 'password' ? 'Sign in' : 'Verify PEM & sign in'}</Button></form><small>{mode === 'password' ? 'Credentials are verified securely by the server.' : 'Only a signed one-time challenge is sent to the server.'}</small></div></div>
}

function Shell({ user, logout }) {
  const hasAccess = useCallback((id) => user.role === 'admin' || (user.role === 'viewer' ? VIEWER_FEATURES.includes(id) : (user.permissions || []).includes(id)), [user])
  const visibleNav = useMemo(() => NAV.filter(([id]) => !['iam', 'security'].includes(id) ? hasAccess(id) : user.role === 'admin'), [hasAccess, user.role])
  const [page, setPage] = useState(() => visibleNav[0]?.[0] || 'dashboard'), [mobile, setMobile] = useState(false), [collapsed, setCollapsed] = useState(false)
  const [theme, setTheme] = useState(localStorage.getItem('boutique_theme') || 'light')
  const [sales, setSales] = useState([]), [notes, setNotes] = useState([]), [loading, setLoading] = useState(true), [notice, setNotice] = useState(null)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const salesAccess = ['dashboard', 'add-sale', 'review', 'update', 'customers', 'vendors', 'analytics', 'reminders', 'bill', 'passbook', 'ai', 'technical'].some(hasAccess)
      const notesAccess = ['notes', 'ai', 'technical'].some(hasAccess)
      const [s, n] = await Promise.all([salesAccess ? request('/sales') : [], notesAccess ? request('/notes') : []])
      setSales(s); setNotes(n)
    } catch (e) { setNotice({ type: 'error', text: e.message }) } finally { setLoading(false) }
  }, [hasAccess])
  useEffect(() => { reload() }, [reload])
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('boutique_theme', theme) }, [theme])
  useEffect(() => { if (!visibleNav.some(([id]) => id === page)) setPage(visibleNav[0]?.[0] || 'dashboard') }, [page, visibleNav])
  function navigate(id) { if (!visibleNav.some(([navId]) => navId === id)) return; setPage(id); setMobile(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const readOnly = user.role === 'viewer'
  const context = { sales, notes, reload, notice: setNotice, loading, readOnly }
  const pages = { dashboard: <Dashboard {...context} go={navigate} canAccess={hasAccess} />, 'add-sale': <AddSale {...context} />, review: <Review {...context} />, update: <UpdateSale {...context} />, customers: <Customers {...context} />, vendors: <Vendors {...context} />, analytics: <Analytics {...context} />, reminders: <Reminders {...context} />, bill: <Billing {...context} />, passbook: <Passbook {...context} />, notes: <Notes {...context} />, ai: <AI />, technical: <Technical {...context} currentUser={user} />, iam: <IAM notice={setNotice} currentUser={user} />, security: <Security notice={setNotice} />, backup: <Backup {...context} /> }
  return <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}><div className="sidebar-top"><div className="brand-lockup"><img src="/krishna_symbol.png" onError={(e) => { e.currentTarget.style.display = 'none' }} /><div><strong>Shree Krishna</strong><span>Boutique manager</span></div></div><button className="mobile-close" onClick={() => setMobile(false)}><X /></button></div><nav>{visibleNav.map(([id, label, Icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => navigate(id)} title={label}><Icon size={18} /><span>{label}</span></button>)}</nav><div className="sidebar-foot"><div className="user-chip"><span>{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><small>{ROLE_LABELS[user.role] || user.role}</small></div></div><button className="nav-logout" onClick={logout}><LogOut size={18} /><span>Sign out</span></button></div></aside>
    <div className="main-area"><header className="topbar"><div><button className="mobile-menu" onClick={() => setMobile(true)}><Menu /></button><button className="collapse" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRight /> : <ChevronLeft />}</button><div className="breadcrumb"><span>Workspace</span><strong>{NAV.find(([id]) => id === page)?.[1]}</strong></div></div><div>{readOnly && <span className="read-only-chip"><Eye size={14}/>Read only</span>}<button className="icon-button" onClick={reload} title="Refresh data"><RefreshCw size={18} /></button><button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title="Toggle theme">{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>{hasAccess('technical') && <button className="icon-button" onClick={() => navigate('technical')} title="Settings"><Settings size={18} /></button>}</div></header><main className="content"><Notice value={notice} clear={() => setNotice(null)} />{loading && <div className="loading-bar" />}{pages[page]}</main></div>
  </div>
}

function calcMetrics(sales) {
  const revenue = sales.reduce((n, x) => n + Number(x.selling_price || 0), 0), buying = sales.reduce((n, x) => n + Number(x.buying_price || 0), 0), pending = sales.reduce((n, x) => n + Number(x.pending_amount || 0), 0)
  return { count: sales.length, revenue, profit: revenue - buying, pending, customers: new Set(sales.map((x) => x.customer_name)).size }
}
function monthlyData(sales) { const map = {}; sales.forEach((x) => { const key = String(x.sale_date || '').slice(0, 7); if (!key) return; map[key] ||= { month: key, revenue: 0, profit: 0 }; map[key].revenue += Number(x.selling_price || 0); map[key].profit += Number(x.selling_price || 0) - Number(x.buying_price || 0) }); return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).slice(-8).map((x) => ({ ...x, month: x.month.slice(5) + '/' + x.month.slice(2, 4) })) }

function Dashboard({ sales, go, canAccess, readOnly }) {
  const m = calcMetrics(sales), monthly = monthlyData(sales), recent = sales.slice(0, 7)
  const quick = [['Record a sale','Create a customer transaction',Plus,'add-sale'],['Review payments','Browse pending accounts',CircleDollarSign,'review'],['View bills','Review customer statements',ReceiptText,'bill'],['View work notes','Browse the activity log',NotebookPen,'notes']].filter(([, , , id]) => canAccess(id) && (!readOnly || id !== 'add-sale'))
  return <><PageHead eyebrow="Business snapshot" title="Good to see you." action={!readOnly && canAccess('add-sale') ? <Button icon={Plus} onClick={() => go('add-sale')}>New sale</Button> : null} /><div className="metrics-grid"><Metric label="Total revenue" value={money(m.revenue)} hint={`${m.count} transactions`} icon={IndianRupee} /><Metric label="Gross profit" value={money(m.profit)} hint={`${m.revenue ? ((m.profit / m.revenue) * 100).toFixed(1) : 0}% margin`} icon={TrendingUp} tone="green" /><Metric label="Pending" value={money(m.pending)} hint="Needs collection" icon={WalletCards} tone="amber" /><Metric label="Customers" value={m.customers} hint="Unique customers" icon={UsersRound} tone="violet" /></div><div className="dashboard-grid"><Card className="chart-card"><div className="card-title"><div><h2>Revenue overview</h2><p>Revenue and gross profit by month</p></div><span className="badge blue">Last 8 months</span></div>{monthly.length ? <ResponsiveContainer width="100%" height={300}><AreaChart data={monthly}><defs><linearGradient id="revenue" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity={.3}/><stop offset="100%" stopColor="#2563eb" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="var(--chart-grid)" /><XAxis dataKey="month" axisLine={false} tickLine={false}/><YAxis axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v/1000}k`}/><Tooltip formatter={(v) => money(v)} /><Area type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={3} fill="url(#revenue)"/><Line type="monotone" dataKey="profit" stroke="#059669" /></AreaChart></ResponsiveContainer> : <Empty icon={BarChart3} title="No chart data" copy="Add your first sale to start the revenue trend." />}</Card><Card className="quick-card"><div className="card-title"><div><h2>{readOnly ? 'Quick links' : 'Quick actions'}</h2><p>{readOnly ? 'Available read-only areas' : 'Common daily tasks'}</p></div></div>{quick.map(([title,copy,Icon,id]) => <button key={id} onClick={() => go(id)}><span><Icon /></span><div><strong>{title}</strong><small>{copy}</small></div><ChevronRight /></button>)}</Card></div><Card className="table-card"><div className="card-title"><div><h2>Recent transactions</h2><p>Latest boutique activity</p></div>{canAccess('review') && <Button variant="ghost" onClick={() => go('review')}>View all</Button>}</div><SalesTable rows={recent} /></Card></>
}

function AddSale({ sales, reload, notice }) { async function save(form) { try { await request('/sales', { method: 'POST', body: JSON.stringify(form) }); notice({ text: 'Sale saved successfully.' }); await reload() } catch (e) { notice({ type: 'error', text: e.message }); throw e } } return <><PageHead eyebrow="Sales desk" title="Add a new sale" /><Card className="form-card"><SaleForm customerSales={sales} onSave={save} /></Card></> }

function SalesTable({ rows, actions }) {
  if (!rows.length) return <Empty icon={ReceiptText} title="No transactions found" />
  return <div className="table-wrap"><table><thead><tr><th>ID</th><th>Customer</th><th>Date</th><th>Item</th><th>Sale</th><th>Paid</th><th>Pending</th><th>Status</th>{actions && <th />}</tr></thead><tbody>{rows.map((x) => <tr key={x.id}><td className="mono">#{x.id}</td><td><strong>{x.customer_name}</strong><small>{x.customer_phone || 'No phone'}</small></td><td>{dateLabel(x.sale_date)}</td><td>{x.product_category}<small>{x.product_description || x.vendor || '—'}</small></td><td>{money(x.selling_price)}</td><td>{money(x.amount_paid)}</td><td className={Number(x.pending_amount) ? 'pending-text' : ''}>{money(x.pending_amount)}</td><td><Status paid={x.payment_received} delayed={x.delay_status} /></td>{actions && <td>{actions(x)}</td>}</tr>)}</tbody></table></div>
}

function Review({ sales, reload, notice, readOnly }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [collect, setCollect] = useState(null)
  const rows = sales.filter((x) => `${x.customer_name} ${x.customer_phone} ${x.vendor} ${x.product_description} ${x.id}`.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || (status === 'pending' ? Number(x.pending_amount) > 0 : Number(x.pending_amount) <= 0)))
  async function exportExcel() {
    const columns = [['ID','id'],['Customer','customer_name'],['Phone','customer_phone'],['Sale date','sale_date'],['Vendor','vendor'],['Category','product_category'],['Description','product_description'],['Buying price','buying_price'],['Selling price','selling_price'],['Amount paid','amount_paid'],['Pending amount','pending_amount'],['Payment method','payment_method'],['Notes','notes']]
    const header = columns.map(([value]) => ({ value, fontWeight: 'bold', color: '#ffffff', backgroundColor: '#2563eb' }))
    const body = rows.map((row) => columns.map(([, key]) => ({ value: row[key] ?? '', type: typeof row[key] === 'number' ? Number : String })))
    await writeXlsxFile([header, ...body], { fileName: `boutique-accounts-${today()}.xlsx`, sheet: 'Accounts' })
  }
  async function payment(data) { try { await request(`/sales/${collect.id}/payment`, { method: 'POST', body: JSON.stringify(data) }); notice({ text: 'Payment recorded.' }); setCollect(null); reload() } catch (e) { notice({ type: 'error', text: e.message }) } }
  return <><PageHead eyebrow="Accounts" title="Review transactions" action={<Button variant="secondary" icon={CloudDownload} onClick={exportExcel}>Export Excel</Button>} /><Card className="toolbar"><div className="search-box"><Search size={18}/><input placeholder="Search customer, phone, vendor or ID…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="segmented">{['all','pending','paid'].map((x) => <button className={status === x ? 'active' : ''} onClick={() => setStatus(x)} key={x}>{x}</button>)}</div><span>{rows.length} records</span></Card><Card className="table-card"><SalesTable rows={rows} actions={readOnly ? null : (x) => Number(x.pending_amount) > 0 && <Button variant="tiny" onClick={() => setCollect(x)}>Collect</Button>} /></Card>{collect && !readOnly && <PaymentModal row={collect} close={() => setCollect(null)} save={payment} />}</>
}
function PaymentModal({ row, close, save }) { const [form, setForm] = useState({ amount: row.pending_amount, date: today(), method: 'UPI', received_by: 'Admin' }); return <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={close}><X /></button><span className="eyebrow">Collect payment</span><h2>{row.customer_name}</h2><p>Pending balance: <strong>{money(row.pending_amount)}</strong></p><div className="form-grid two"><Field label="Amount" type="number" max={row.pending_amount} value={form.amount} onChange={(e) => setForm({...form, amount:e.target.value})}/><Field label="Date" type="date" value={form.date} onChange={(e) => setForm({...form, date:e.target.value})}/><Field label="Method" as="select" value={form.method} onChange={(e) => setForm({...form, method:e.target.value})}>{PAYMENT_METHODS.slice(0,4).map(x=><option key={x}>{x}</option>)}</Field><Field label="Received by" value={form.received_by} onChange={(e) => setForm({...form, received_by:e.target.value})}/></div><Button onClick={() => save(form)} icon={CircleDollarSign}>Record collection</Button></div></div> }

function UpdateSale({ sales, reload, notice }) {
  const [id, setId] = useState(sales[0]?.id || ''), row = sales.find((x) => Number(x.id) === Number(id))
  async function save(form) { try { await request(`/sales/${id}`, { method: 'PUT', body: JSON.stringify(form) }); notice({ text: `Transaction #${id} updated.` }); reload() } catch (e) { notice({ type: 'error', text: e.message }) } }
  async function del() { if (!confirm(`Delete transaction #${id}?`)) return; await request(`/sales/${id}`, { method: 'DELETE' }); notice({ text: 'Transaction deleted.' }); reload() }
  return <><PageHead eyebrow="Transaction editor" title="Update a sale" /><Card className="selector-card"><Field label="Choose transaction" as="select" value={id} onChange={(e) => setId(e.target.value)}>{sales.map((x) => <option value={x.id} key={x.id}>#{x.id} · {x.customer_name} · {dateLabel(x.sale_date)} · {money(x.selling_price)}</option>)}</Field></Card>{row ? <Card className="form-card"><SaleForm key={row.id} initial={{...row}} onSave={save} submitLabel="Save changes" /><Button className="danger-zone" variant="danger" icon={Trash2} onClick={del}>Delete transaction</Button></Card> : <Empty title="No transaction selected" />}</>
}

function Customers({ sales }) {
  const [q, setQ] = useState('')
  const customers = useMemo(() => { const map = {}; sales.forEach((x) => { const k=x.customer_name; map[k] ||= { name:k, phone:x.customer_phone, visits:0, spent:0, pending:0, last:x.sale_date }; const a=map[k]; a.visits++; a.spent+=Number(x.selling_price||0); a.pending+=Number(x.pending_amount||0); if(String(x.sale_date)>String(a.last)) a.last=x.sale_date }); return Object.values(map).sort((a,b)=>b.spent-a.spent) }, [sales])
  const rows = customers.filter((x) => `${x.name} ${x.phone}`.toLowerCase().includes(q.toLowerCase()))
  return <><PageHead eyebrow="Relationships" title="Customer directory" /><Card className="toolbar"><div className="search-box"><Search/><input placeholder="Find a customer…" value={q} onChange={(e)=>setQ(e.target.value)}/></div><span>{rows.length} customers</span></Card><div className="people-grid">{rows.map((x,i)=><Card className="person-card" key={x.name}><div className="avatar" style={{background:COLORS[i%COLORS.length]}}>{x.name[0]}</div><div className="person-head"><h3>{x.name}</h3><p>{x.phone||'No phone number'}</p></div><div className="person-stats"><div><span>Total spent</span><strong>{money(x.spent)}</strong></div><div><span>Transactions</span><strong>{x.visits}</strong></div><div><span>Pending</span><strong className={x.pending?'pending-text':''}>{money(x.pending)}</strong></div><div><span>Last visit</span><strong>{dateLabel(x.last)}</strong></div></div></Card>)}</div>{!rows.length&&<Empty icon={UsersRound} title="No customers found"/>}</>
}

function Vendors({ sales }) { const map={}; sales.forEach((x)=>{if(!x.vendor)return; map[x.vendor]||={name:x.vendor,sales:0,cost:0,revenue:0};map[x.vendor].sales++;map[x.vendor].cost+=Number(x.buying_price||0);map[x.vendor].revenue+=Number(x.selling_price||0)}); const rows=Object.values(map); return <><PageHead eyebrow="Supply network" title="Vendor directory" /><div className="people-grid">{rows.map((x,i)=><Card className="person-card" key={x.name}><div className="avatar square" style={{background:COLORS[(i+2)%COLORS.length]}}><ShoppingBag/></div><div className="person-head"><h3>{x.name}</h3><p>Active supplier</p></div><div className="person-stats"><div><span>Sale records</span><strong>{x.sales}</strong></div><div><span>Purchase value</span><strong>{money(x.cost)}</strong></div><div><span>Sales value</span><strong>{money(x.revenue)}</strong></div></div></Card>)}</div>{!rows.length&&<Empty icon={ShoppingBag} title="No vendors yet" copy="Vendor names from sales will appear here."/>}</> }

function Analytics({ sales }) {
  const [tab,setTab]=useState('trends'), m=calcMetrics(sales), monthly=monthlyData(sales)
  const grouped=(key)=>Object.values(sales.reduce((map,x)=>{const name=x[key]||'Other';map[name]||={name,value:0,count:0};map[name].value+=Number(x.selling_price||0);map[name].count++;return map},{})).sort((a,b)=>b.value-a.value)
  const data=tab==='categories'?grouped('product_category'):tab==='payments'?grouped('payment_method'):grouped('customer_name').slice(0,10)
  return <><PageHead eyebrow="Business intelligence" title="Analytics" /><div className="metrics-grid compact"><Metric label="Average order" value={money(m.count?m.revenue/m.count:0)} icon={ReceiptText}/><Metric label="Gross margin" value={`${m.revenue?(m.profit/m.revenue*100).toFixed(1):0}%`} icon={TrendingUp} tone="green"/><Metric label="Collection rate" value={`${m.revenue?((m.revenue-m.pending)/m.revenue*100).toFixed(1):0}%`} icon={WalletCards} tone="amber"/></div><div className="tabs">{['trends','customers','categories','payments'].map(x=><button className={tab===x?'active':''} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div><Card className="chart-card analytics-chart">{tab==='trends'?<><div className="card-title"><div><h2>Sales performance</h2><p>Monthly revenue and gross profit</p></div></div><ResponsiveContainer width="100%" height={380}><LineChart data={monthly}><CartesianGrid vertical={false} stroke="var(--chart-grid)"/><XAxis dataKey="month"/><YAxis tickFormatter={v=>`₹${v/1000}k`}/><Tooltip formatter={money}/><Legend/><Line type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={3}/><Line type="monotone" dataKey="profit" stroke="#059669" strokeWidth={3}/></LineChart></ResponsiveContainer></>:<><div className="card-title"><div><h2>{tab[0].toUpperCase()+tab.slice(1)} breakdown</h2><p>Revenue contribution</p></div></div><div className="split-chart"><ResponsiveContainer width="55%" height={380}><BarChart data={data} layout="vertical"><CartesianGrid horizontal={false} stroke="var(--chart-grid)"/><XAxis type="number" tickFormatter={v=>`₹${v/1000}k`}/><YAxis dataKey="name" type="category" width={120}/><Tooltip formatter={money}/><Bar dataKey="value" fill="#2563eb" radius={[0,6,6,0]}/></BarChart></ResponsiveContainer><ResponsiveContainer width="45%" height={380}><PieChart><Pie data={data} dataKey="value" nameKey="name" innerRadius={65} outerRadius={110}>{data.map((_,i)=><Cell fill={COLORS[i%COLORS.length]} key={i}/>)}</Pie><Tooltip formatter={money}/></PieChart></ResponsiveContainer></div></>}</Card></>
}

function Reminders({ sales, reload, notice }) { const [tab,setTab]=useState('overdue'); const rows=sales.filter(x=>{const age=differenceInDays(new Date(),new Date(x.sale_date)); if(tab==='overdue')return Number(x.pending_amount)>0&&age>=30;if(tab==='flagged')return x.delay_status;if(tab==='high')return Number(x.pending_amount)>=5000;return Number(x.pending_amount)>0&&age<30}).sort((a,b)=>Number(b.pending_amount)-Number(a.pending_amount)); return <><PageHead eyebrow="Follow-up centre" title="Reminders & alerts" /><div className="tabs">{[['overdue','Overdue 30d+'],['flagged','Flagged'],['high','High value'],['upcoming','Upcoming']].map(([id,l])=><button className={tab===id?'active':''} onClick={()=>setTab(id)} key={id}>{l}</button>)}</div><Card className="table-card"><SalesTable rows={rows}/></Card></> }

function Billing({ sales, notice, readOnly }) {
  const names = [...new Set(sales.map((x) => x.customer_name).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const [customer, setCustomer] = useState(''), [scope, setScope] = useState('All Transactions'), [limit, setLimit] = useState(5)
  const [billDate, setBillDate] = useState(today()), [history, setHistory] = useState([]), [historySearch, setHistorySearch] = useState('')
  const [selectedBill, setSelectedBill] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { if (!customer && names.length) setCustomer(names[0]) }, [customer, names])
  const loadHistory = useCallback(() => request('/bills').then((rows) => { const sorted = rows.sort((a,b)=>String(b.generated_at).localeCompare(String(a.generated_at))); setHistory(sorted); if (!selectedBill && sorted.length) setSelectedBill(sorted[0].bill_id) }).catch((e) => notice({type:'error',text:e.message})), [notice, selectedBill])
  useEffect(() => { loadHistory() }, [])
  let rows = sales.filter((x) => x.customer_name === customer)
  if (scope === 'Pending Transactions') rows = rows.filter((x) => Number(x.pending_amount) > 0)
  if (scope === 'Last Transactions') rows = [...rows].sort((a,b)=>String(b.sale_date).localeCompare(String(a.sale_date))||Number(b.id)-Number(a.id)).slice(0, limit)
  rows = [...rows].sort((a,b)=>String(a.sale_date).localeCompare(String(b.sale_date))||Number(a.id)-Number(b.id))
  const totals = calcMetrics(rows), selectedDoc = history.find((x) => x.bill_id === selectedBill)
  const shownHistory = history.filter((x) => `${x.bill_id} ${x.customer_name} ${x.customer_phone}`.toLowerCase().includes(historySearch.toLowerCase()))
  async function generate() {
    if (!customer || !rows.length) return
    setBusy(true)
    try {
      const token = localStorage.getItem('boutique_token')
      const response = await fetch('/api/bills/generate', { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({customer_name:customer,bill_scope:scope,bill_limit:limit,bill_date:billDate}) })
      if (!response.ok) { const error = await response.json().catch(()=>({})); throw new Error(formatError(error.error || error, 'Could not generate the bill.')) }
      const blob = await response.blob(), disposition = response.headers.get('Content-Disposition') || '', id = response.headers.get('X-Bill-ID') || 'bill'
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `${id}.pdf`, url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url)
      notice({text:`Bill ${id} generated, saved to history, and downloaded.`}); await loadHistory()
    } catch (e) { notice({type:'error',text:e.message}) } finally { setBusy(false) }
  }
  return <><PageHead eyebrow="Customer PDF statement" title="Generate a bill" />
    <Card className="bill-controls"><div className="form-grid four"><Field label="Customer" as="select" value={customer} onChange={(e)=>setCustomer(e.target.value)}>{names.map((name)=>{const all=sales.filter(x=>x.customer_name===name),m=calcMetrics(all);return <option value={name} key={name}>{name} — Pending {money(m.pending)} / Total {money(m.revenue)}</option>})}</Field><Field label="Bill type" as="select" value={scope} onChange={(e)=>setScope(e.target.value)}><option>All Transactions</option><option>Last Transactions</option><option>Pending Transactions</option></Field><Field label="Last transactions" type="number" min="1" max="100" disabled={scope!=='Last Transactions'} value={limit} onChange={(e)=>setLimit(Number(e.target.value))}/><Field label="Bill date" type="date" value={billDate} onChange={(e)=>setBillDate(e.target.value)}/></div></Card>
    <div className="metrics-grid"><Metric label="Purchases" value={rows.length} icon={ReceiptText}/><Metric label="Total bill" value={money(totals.revenue)} icon={IndianRupee}/><Metric label="Paid" value={money(totals.revenue-totals.pending)} icon={CircleDollarSign} tone="green"/><Metric label="Pending" value={money(totals.pending)} icon={WalletCards} tone="amber"/></div>
    <Card className="invoice-preview"><div className="invoice-head"><div><span className="eyebrow">{scope==='Last Transactions'?`Last ${limit} transactions`:scope}</span><h2>Shree Krishna Boutique</h2><p>{customer||'Select a customer'}</p></div><div><span>Total due</span><strong>{money(totals.pending)}</strong></div></div><SalesTable rows={rows}/><div className="invoice-total"><span>Total billed <strong>{money(totals.revenue)}</strong></span><span>Paid <strong>{money(totals.revenue-totals.pending)}</strong></span><span>Balance <strong>{money(totals.pending)}</strong></span></div>{!readOnly && <Button icon={FileText} onClick={generate} disabled={!rows.length||busy}>{busy?'Generating with Python…':'Generate bill PDF'}</Button>}</Card>
    <div className="section-divider"><span>Bill history</span></div><Card className="table-card"><div className="card-title"><div><h2>Generated bills</h2><p>Permanent bill IDs and transaction snapshots</p></div><div className="search-box"><Search/><input placeholder="Search bill, customer or phone…" value={historySearch} onChange={(e)=>setHistorySearch(e.target.value)}/></div></div>{shownHistory.length?<div className="table-wrap"><table><thead><tr><th>Bill ID</th><th>Customer</th><th>Type</th><th>Date</th><th>Purchases</th><th>Total</th><th>Paid</th><th>Pending</th></tr></thead><tbody>{shownHistory.map((x)=><tr key={x.bill_id} className={selectedBill===x.bill_id?'selected-row':''} onClick={()=>setSelectedBill(x.bill_id)}><td className="mono">{x.bill_id}</td><td><strong>{x.customer_name}</strong><small>{x.customer_phone||'No phone'}</small></td><td>{x.bill_scope_label||x.bill_scope}</td><td>{dateLabel(x.bill_date)}</td><td>{x.purchase_count}</td><td>{money(x.total_bill)}</td><td>{money(x.total_paid)}</td><td className={Number(x.total_pending)?'pending-text':''}>{money(x.total_pending)}</td></tr>)}</tbody></table></div>:<Empty icon={ReceiptText} title="No generated bills found"/>}</Card>
    {selectedDoc?.items?.length>0&&<Card className="table-card bill-detail"><div className="card-title"><div><h2>{selectedDoc.bill_id}</h2><p>{selectedDoc.customer_name} · Generated {dateLabel(selectedDoc.generated_at)} by {selectedDoc.generated_by}</p></div><span className={`badge ${Number(selectedDoc.total_pending)?'amber':'green'}`}>{Number(selectedDoc.total_pending)?'Pending':'Paid'}</span></div><div className="table-wrap"><table><thead><tr><th>Sale ID</th><th>Date</th><th>Category</th><th>Description</th><th>Bill</th><th>Paid</th><th>Pending</th><th>Status</th></tr></thead><tbody>{selectedDoc.items.map((x)=><tr key={x.sale_id}><td className="mono">#{x.sale_id}</td><td>{dateLabel(x.sale_date)}</td><td>{x.category}</td><td>{x.description||'—'}</td><td>{money(x.bill_amount)}</td><td>{money(x.paid_amount)}</td><td>{money(x.pending_amount)}</td><td><span className={`badge ${x.status?.startsWith('PAID')?'green':'amber'}`}>{x.status}</span></td></tr>)}</tbody></table></div></Card>}
  </>
}

function passbookDate(value) { const parts=String(value||'').split('/'); return parts.length===3?`${parts[2]}-${parts[1]}-${parts[0]}`:today() }
function Passbook({ sales, reload, notice }) {
  const [files,setFiles]=useState([]),[passbooks,setPassbooks]=useState([]),[selectedIdx,setSelectedIdx]=useState(0),[nameFilter,setNameFilter]=useState('All Names'),[typeFilter,setTypeFilter]=useState('All'),[vendors,setVendors]=useState([]),[busy,setBusy]=useState(false),[selectedTxn,setSelectedTxn]=useState(0)
  const [customerMode,setCustomerMode]=useState('existing')
  const [sale,setSale]=useState({customer_name:'',customer_phone:'',sale_date:today(),product_category:'Sarees',vendor:'',quantity:1,product_description:'',buying_price:0,selling_price:0,amount_paid:0,payment_method:'UPI',notes:''})
  const loadVendors=useCallback(()=>request('/passbook/vendors').then(setVendors).catch(()=>{}),[])
  useEffect(()=>{loadVendors()},[loadVendors])
  async function parse(){setBusy(true);const body=new FormData();files.forEach((file)=>body.append('files',file));try{const data=await request('/passbook/parse',{method:'POST',body,timeout:90000});setPassbooks(data.passbooks||[]);setSelectedIdx(0);setNameFilter('All Names');setTypeFilter('All');notice({text:`${data.passbooks?.length||0} passbook PDF(s) parsed with the Python extractor.`})}catch(e){notice({type:'error',text:e.message})}finally{setBusy(false)}}
  const pb=passbooks[selectedIdx], allRows=pb?.transactions||[], names=[...new Set(allRows.map((x)=>x.Name).filter(Boolean))].sort((a,b)=>a.localeCompare(b)), vendorKeys=new Set(vendors.map((x)=>x.toLowerCase()))
  const filtered=allRows.filter((x)=>(nameFilter==='All Names'||(nameFilter==='Saved Vendors'?vendorKeys.has(String(x.Name).toLowerCase()):x.Name===nameFilter))&&(typeFilter==='All'||(typeFilter==='Credit'?Number(x.Credit)>0:Number(x.Debit)>0)))
  const currentTxn=filtered[selectedTxn]||filtered[0], totalCredit=filtered.reduce((n,x)=>n+Number(x.Credit||0),0),totalDebit=filtered.reduce((n,x)=>n+Number(x.Debit||0),0),lastBalance=filtered.length?Number(filtered[filtered.length-1].Balance||0):0
  useEffect(()=>{setSelectedTxn(0)},[nameFilter,typeFilter,selectedIdx])
  useEffect(()=>{if(!currentTxn)return;const txnAmount=Number(currentTxn.Debit||0)||Number(currentTxn.Credit||0);setSale((old)=>({...old,sale_date:passbookDate(currentTxn.Date),vendor:currentTxn.Name||'',product_description:currentTxn.Description||'',buying_price:txnAmount,selling_price:txnAmount,amount_paid:0,notes:`From passbook transaction: ${currentTxn.Description||''}`}))},[currentTxn?.Date,currentTxn?.Description,currentTxn?.Name,currentTxn?.Debit,currentTxn?.Credit])
  async function toggleVendor(){if(!nameFilter||['All Names','Saved Vendors'].includes(nameFilter))return;const saved=vendorKeys.has(nameFilter.toLowerCase());try{await request(`/passbook/vendors${saved?`/${encodeURIComponent(nameFilter)}`:''}`,{method:saved?'DELETE':'POST',...(saved?{}:{body:JSON.stringify({name:nameFilter})})});await loadVendors();notice({text:`${nameFilter} ${saved?'removed from':'saved as'} vendor.`})}catch(e){notice({type:'error',text:e.message})}}
  function downloadCsv(){const columns=['Date','Name','Description','Debit','Credit','Balance'],escape=(v)=>`"${String(v??'').replaceAll('"','""')}"`,csv=[columns.join(','),...filtered.map((row)=>columns.map((key)=>escape(row[key])).join(','))].join('\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})),link=document.createElement('a');link.href=url;link.download=`passbook_${(nameFilter==='All Names'?pb.customer_name:nameFilter).replace(/\W+/g,'_').toLowerCase()}_${today()}.csv`;link.click();URL.revokeObjectURL(url)}
  async function saveSale(e){e.preventDefault();if(!currentTxn)return;try{await request('/sales',{method:'POST',body:JSON.stringify({...sale,passbook_source:{date:currentTxn.Date,name:currentTxn.Name,description:currentTxn.Description,debit:Number(currentTxn.Debit||0),credit:Number(currentTxn.Credit||0),balance:Number(currentTxn.Balance||0)}})});notice({text:`Sale added for ${sale.customer_name} from the passbook transaction.`});await reload()}catch(e){notice({type:'error',text:e.message})}}
  return <><PageHead eyebrow="PDF statement extractor" title="Passbook reader" />
    <Card className="upload-card"><span className="upload-icon"><Upload/></span><h2>Upload passbook PDFs</h2><p>The original Python table and text extraction logic reads account details, debit/credit rows, names, and balances.</p><input type="file" accept="application/pdf" multiple onChange={(e)=>setFiles([...e.target.files])}/><Button onClick={parse} disabled={!files.length||busy} icon={FileSearch}>{busy?'Reading with Python…':`Read ${files.length||''} passbook${files.length===1?'':'s'}`}</Button></Card>
    {pb&&<><Card className="passbook-account"><div className="card-title"><div><span className="eyebrow">Account details</span><h2>{pb.customer_name||pb.filename}</h2><p>{pb.bank} · {pb.statement_date||pb.statement_period}</p></div><span className="badge blue">{pb.filename}</span></div><div className="account-grid"><div><span>Account</span><strong>{pb.account_no_15||pb.account_no||'—'}</strong></div><div><span>IFSC</span><strong>{pb.ifsc||'—'}</strong></div><div><span>Branch</span><strong>{pb.branch||'—'}</strong></div><div><span>Account type</span><strong>{pb.account_type||'—'}</strong></div></div>{pb.address&&<p className="account-address">{pb.address}</p>}</Card>
      <Card className="passbook-filters"><div className="form-grid three"><Field label="Name filter" as="select" value={nameFilter} onChange={(e)=>setNameFilter(e.target.value)}><option>All Names</option><option>Saved Vendors</option>{names.map((x)=><option key={x}>{x}</option>)}</Field><Field label="Passbook" as="select" value={selectedIdx} onChange={(e)=>setSelectedIdx(Number(e.target.value))}>{passbooks.map((x,i)=><option value={i} key={`${x.filename}-${i}`}>{x.customer_name} — {x.statement_date||x.account_no_15||x.filename}</option>)}</Field><Field label="Type" as="select" value={typeFilter} onChange={(e)=>setTypeFilter(e.target.value)}><option>All</option><option>Credit</option><option>Debit</option></Field></div><div className="filter-actions"><Button variant="secondary" onClick={toggleVendor} disabled={['All Names','Saved Vendors'].includes(nameFilter)}>{vendorKeys.has(nameFilter.toLowerCase())?'Remove vendor':'Mark as vendor'}</Button><span>{vendors.length} saved vendors</span></div></Card>
      <div className="metrics-grid"><Metric label="Rows" value={filtered.length} icon={ClipboardList}/><Metric label="Credits" value={money(totalCredit)} icon={TrendingUp} tone="green"/><Metric label="Debits" value={money(totalDebit)} icon={WalletCards} tone="amber"/><Metric label="Last balance" value={money(lastBalance)} icon={IndianRupee}/></div>
      <Card className="table-card"><div className="card-title"><div><h2>Transactions</h2><p>{nameFilter} · {typeFilter}</p></div><Button variant="secondary" icon={CloudDownload} disabled={!filtered.length} onClick={downloadCsv}>Download filtered CSV</Button></div>{filtered.length?<div className="table-wrap passbook-table"><table><thead><tr><th>Date</th><th>Name</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>{filtered.map((x,i)=><tr key={`${x.Date}-${x.Description}-${i}`} className={selectedTxn===i?'selected-row':''} onClick={()=>setSelectedTxn(i)}><td>{x.Date}</td><td><strong>{x.Name}</strong></td><td>{x.Description}</td><td className={Number(x.Debit)?'pending-text':''}>{Number(x.Debit)?money(x.Debit):'—'}</td><td className={Number(x.Credit)?'credit-text':''}>{Number(x.Credit)?money(x.Credit):'—'}</td><td>{money(x.Balance)}</td></tr>)}</tbody></table></div>:<Empty icon={FileSearch} title="No transaction rows match this filter"/>}</Card>
      {currentTxn&&<Card className="passbook-sale"><div className="card-title"><div><h2>Add sale from transaction</h2><p>{currentTxn.Date} · {currentTxn.Name} · Debit {money(currentTxn.Debit)} · Credit {money(currentTxn.Credit)}</p></div><span className="badge blue">Selected row {selectedTxn+1}</span></div><Field label="Select transaction" as="select" value={selectedTxn} onChange={(e)=>setSelectedTxn(Number(e.target.value))}>{filtered.map((x,i)=><option value={i} key={i}>{x.Date} — {x.Name} — Debit {money(x.Debit)} — Credit {money(x.Credit)}</option>)}</Field><div className="customer-mode"><span>Customer type</span><div className="segmented"><button className={customerMode==='existing'?'active':''} onClick={()=>setCustomerMode('existing')}>Existing customer</button><button className={customerMode==='new'?'active':''} onClick={()=>{setCustomerMode('new');setSale({...sale,customer_name:'',customer_phone:''})}}>New customer</button></div></div><form onSubmit={saveSale}><div className="form-grid three">{customerMode==='existing'?<Field label="Search existing customer *" as="select" required value={sale.customer_name} onChange={(e)=>{const name=e.target.value,phone=[...sales].sort((a,b)=>String(b.sale_date).localeCompare(String(a.sale_date))).find((x)=>x.customer_name===name)?.customer_phone||'';setSale({...sale,customer_name:name,customer_phone:phone})}}><option value="">Choose customer…</option>{[...new Set(sales.map((x)=>x.customer_name).filter(Boolean))].sort().map((name)=><option value={name} key={name}>{name}</option>)}</Field>:<Field label="Customer name *" value={sale.customer_name} onChange={(e)=>setSale({...sale,customer_name:e.target.value})} required/>}<Field label="Phone" value={sale.customer_phone} onChange={(e)=>setSale({...sale,customer_phone:e.target.value})}/><Field label="Sale date" type="date" value={sale.sale_date} onChange={(e)=>setSale({...sale,sale_date:e.target.value})}/><Field label="Category *" as="select" value={sale.product_category} onChange={(e)=>setSale({...sale,product_category:e.target.value})}>{CATEGORIES.map((x)=><option key={x}>{x}</option>)}</Field><Field label="Vendor *" value={sale.vendor} onChange={(e)=>setSale({...sale,vendor:e.target.value})} required/><Field label="Quantity" type="number" min="1" value={sale.quantity} onChange={(e)=>setSale({...sale,quantity:Number(e.target.value)})}/></div><Field label="Description" as="textarea" rows="2" value={sale.product_description} onChange={(e)=>setSale({...sale,product_description:e.target.value})}/><div className="form-grid four"><Field label="Buying price *" type="number" min="0.01" step="0.01" value={sale.buying_price} onChange={(e)=>setSale({...sale,buying_price:Number(e.target.value)})}/><Field label="Selling price *" type="number" min="0.01" step="0.01" value={sale.selling_price} onChange={(e)=>setSale({...sale,selling_price:Number(e.target.value)})}/><Field label="Amount paid" type="number" min="0" step="0.01" value={sale.amount_paid} onChange={(e)=>setSale({...sale,amount_paid:Number(e.target.value)})}/><Field label="Payment method" as="select" value={sale.payment_method} onChange={(e)=>setSale({...sale,payment_method:e.target.value})}>{PAYMENT_METHODS.map((x)=><option key={x}>{x}</option>)}</Field></div><div className="sale-summary"><span>Pending <strong>{money(Math.max(Number(sale.selling_price)-Number(sale.amount_paid),0))}</strong></span><span>Profit <strong>{money((Number(sale.selling_price)-Number(sale.buying_price))*Number(sale.quantity||1))}</strong></span><span>Total value <strong>{money(Number(sale.selling_price)*Number(sale.quantity||1))}</strong></span></div><Field label="Notes" as="textarea" rows="2" value={sale.notes} onChange={(e)=>setSale({...sale,notes:e.target.value})}/><Button icon={Plus}>Save sale</Button></form></Card>}
      <details className="details-card"><summary>Saved vendors ({vendors.length})</summary>{vendors.length?<div className="vendor-chips">{vendors.map((x)=><span key={x}>{x}<button onClick={async()=>{await request(`/passbook/vendors/${encodeURIComponent(x)}`,{method:'DELETE'});loadVendors()}}><X/></button></span>)}</div>:<p>No saved vendors yet.</p>}</details><details className="details-card"><summary>All names found ({names.length})</summary><div className="name-counts">{names.map((name)=><span key={name}>{name}<strong>{allRows.filter((x)=>x.Name===name).length}</strong></span>)}</div></details>
    </>}
  </>
}

function Notes({ notes,reload,notice,readOnly }) { const [form,setForm]=useState({work_date:today(),note:''});async function save(e){e.preventDefault();try{await request('/notes',{method:'POST',body:JSON.stringify(form)});setForm({...form,note:''});notice({text:'Work note saved.'});reload()}catch(e){notice({type:'error',text:e.message})}}async function del(id){await request(`/notes/${id}`,{method:'DELETE'});reload()}return <><PageHead eyebrow="Manual activity log" title="Work notes" />{!readOnly&&<Card className="note-entry"><form onSubmit={save}><Field label="Date" type="date" value={form.work_date} onChange={e=>setForm({...form,work_date:e.target.value})}/><Field label="What did you work on?" value={form.note} onChange={e=>setForm({...form,note:e.target.value})} placeholder="Updated accounts, checked passbook…"/><Button icon={NotebookPen}>Save note</Button></form></Card>}<div className="timeline">{notes.map(x=><div className="timeline-row" key={x.id}><div className="timeline-dot"/><Card><div><span>{dateLabel(x.work_date)}</span><small>Saved by {x.created_by} · {dateLabel(x.created_at)}</small></div><p>{x.note}</p>{!readOnly&&<button className="row-action danger" onClick={()=>del(x.id)}><Trash2/></button>}</Card></div>)}</div>{!notes.length&&<Empty icon={NotebookPen} title="No work notes yet"/>}</> }

function AI(){const quick=['Summarize today’s business status and what needs attention.','List customers with the most pending amount and suggest follow-up priority.','Find sales or vendors that look unusual.','Draft polite payment reminder messages for pending customers.','Summarize recent work notes and suggest next actions.'];const[q,setQ]=useState(quick[0]),[answer,setAnswer]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');async function ask(){setBusy(true);setError('');try{const r=await request('/ai',{method:'POST',body:JSON.stringify({question:q})});setAnswer(r.answer)}catch(e){setError(e.message)}finally{setBusy(false)}}return <><PageHead eyebrow="Data-aware assistant" title="AI assistant" /><div className="ai-layout"><Card className="ai-compose"><span className="ai-orb"><Bot/></span><h2>What would you like to know?</h2><p>The assistant receives a protected summary of your sales and work notes.</p><Field label="Quick question" as="select" value={q} onChange={e=>setQ(e.target.value)}>{quick.map(x=><option key={x}>{x}</option>)}<option>Custom question</option></Field><Field label="Question" as="textarea" rows="5" value={q} onChange={e=>setQ(e.target.value)}/><Button onClick={ask} disabled={busy||!q} icon={Sparkles}>{busy?'Thinking…':'Ask assistant'}</Button>{error&&<p className="form-error">{error}</p>}</Card><Card className="ai-answer">{answer?<><span className="eyebrow">Assistant response</span><div className="answer-text">{answer}</div></>:<Empty icon={Bot} title="Your answer will appear here" copy="Ask about accounts, collections, vendors or daily priorities."/>}</Card></div></>}

const blankSmtp = () => ({ provider:'gmail',enabled:true,host:'smtp.gmail.com',port:465,secure:true,user:'',password:'',from_name:'Shree Krishna Boutique',from_email:'',reply_to:'',test_to:'',password_configured:false })
function Technical({sales,notes,currentUser,notice}) {
  const [health,setHealth]=useState(null),[smtp,setSmtp]=useState(blankSmtp()),[smtpBusy,setSmtpBusy]=useState(false),[testing,setTesting]=useState(false),[smtpResult,setSmtpResult]=useState(null)
  useEffect(()=>{request('/health').then(setHealth);if(currentUser.role==='admin')request('/smtp').then((row)=>setSmtp({...blankSmtp(),...row,password:'',test_to:row.from_email||row.user||''})).catch((e)=>notice({type:'error',text:e.message}))},[currentUser.role,notice])
  const collections=[['Sales',sales.length],['Work notes',notes.length]]
  function smtpSet(key,value){setSmtp((old)=>({...old,[key]:value}))}
  function chooseProvider(provider){setSmtp((old)=>provider==='gmail'?{...old,provider,host:'smtp.gmail.com',port:465,secure:true,from_email:old.from_email||old.user}:{...old,provider,host:old.provider==='gmail'?'':old.host,port:587,secure:false})}
  async function saveSmtp(e){e.preventDefault();setSmtpBusy(true);setSmtpResult(null);try{const {test_to:_testTo,password_configured:_configured,...payload}=smtp;const saved=await request('/smtp',{method:'PUT',body:JSON.stringify(payload)});setSmtp((old)=>({...old,...saved,password:'',test_to:old.test_to||saved.from_email}));notice({text:'SMTP email settings saved securely.'})}catch(e){setSmtpResult({type:'error',text:e.message});notice({type:'error',text:e.message})}finally{setSmtpBusy(false)}}
  async function testSmtp(){setTesting(true);setSmtpResult(null);try{await request('/smtp/test',{method:'POST',body:JSON.stringify({to:smtp.test_to}),timeout:30000});const text=`Test email sent successfully to ${smtp.test_to}.`;setSmtpResult({type:'success',text});notice({text})}catch(e){setSmtpResult({type:'error',text:e.message});notice({type:'error',text:e.message})}finally{setTesting(false)}}
  return <><PageHead eyebrow="System administration" title="Technical overview" />
    <div className="metrics-grid compact"><Metric label="API status" value={health?.ok?'Online':'Checking…'} icon={Activity} tone="green"/><Metric label="Database" value={health?.database||'—'} icon={Database}/><Metric label="App version" value="3.0 React" icon={Sparkles} tone="violet"/></div>
    <div className="technical-layout"><Card className="technical-card"><div className="card-title"><div><h2>Data collections</h2><p>Live records available to this workspace</p></div></div>{collections.map(([n,v])=><div className="collection-row" key={n}><span><Database/>{n}</span><strong>{v} documents</strong></div>)}</Card>
      {currentUser.role==='admin'?<Card className="smtp-card"><div className="card-title"><div><h2>Outgoing email · SMTP</h2><p>Connect Gmail or another provider to send workspace email</p></div><span className={`badge ${smtp.password_configured&&smtp.enabled?'green':'amber'}`}>{!smtp.password_configured?'Setup required':smtp.enabled?'Configured':'Configured · disabled'}</span></div>
        <form onSubmit={saveSmtp}><div className="smtp-provider"><button type="button" className={smtp.provider==='gmail'?'active':''} onClick={()=>chooseProvider('gmail')}><span className="oauth-google">G</span><strong>Google Gmail</strong><small>App Password authentication</small></button><button type="button" className={smtp.provider==='custom'?'active':''} onClick={()=>chooseProvider('custom')}><Settings/><strong>Custom SMTP</strong><small>Your own mail server</small></button></div>
          <div className="form-grid two"><Field label="SMTP host" value={smtp.host} onChange={(e)=>smtpSet('host',e.target.value)} required/><Field label="Port" type="number" min="1" max="65535" value={smtp.port} onChange={(e)=>smtpSet('port',Number(e.target.value))} required/><Field label="SMTP username / Google email" type="email" value={smtp.user} onChange={(e)=>setSmtp((old)=>({...old,user:e.target.value,from_email:old.from_email||e.target.value,test_to:old.test_to||e.target.value}))} required/><Field label={smtp.password_configured?'New app password (leave blank to keep current)':'Google App Password / SMTP password'} type="password" value={smtp.password} onChange={(e)=>smtpSet('password',e.target.value)} required={!smtp.password_configured}/><Field label="Sender name" value={smtp.from_name} onChange={(e)=>smtpSet('from_name',e.target.value)} required/><Field label="From email" type="email" value={smtp.from_email} onChange={(e)=>smtpSet('from_email',e.target.value)} required/><Field label="Reply-to email (optional)" type="email" value={smtp.reply_to} onChange={(e)=>smtpSet('reply_to',e.target.value)}/><Field label="Connection security" as="select" value={smtp.secure?'ssl':'starttls'} onChange={(e)=>setSmtp((old)=>({...old,secure:e.target.value==='ssl',port:e.target.value==='ssl'?465:587}))}><option value="ssl">SSL/TLS · usually port 465</option><option value="starttls">STARTTLS · usually port 587</option></Field></div>
          <label className="switch-row"><input type="checkbox" checked={smtp.enabled} onChange={(e)=>smtpSet('enabled',e.target.checked)}/><span><strong>Enable outgoing email</strong><small>Allows server features to send through this account.</small></span></label>
          <div className="smtp-secret-note"><ShieldCheck/><span><strong>Your mail password is encrypted before MongoDB storage.</strong><small>For Gmail, use a Google App Password—not your normal Google password.</small></span></div>
          <div className="form-actions"><Button icon={Mail} disabled={smtpBusy}>{smtpBusy?'Saving…':'Save email setup'}</Button></div>
        </form>
        <div className="smtp-test"><Field label="Send test email to" type="email" value={smtp.test_to} onChange={(e)=>smtpSet('test_to',e.target.value)} placeholder="you@example.com"/><Button type="button" variant="secondary" icon={Send} disabled={testing||!smtp.password_configured||!smtp.test_to} onClick={testSmtp}>{testing?'Sending…':'Send test'}</Button></div>{smtpResult&&<div className={`smtp-result ${smtpResult.type}`}><span>{smtpResult.type==='success'?<CheckCircle2/>:<AlertTriangle/>}</span><p>{smtpResult.text}</p></div>}
      </Card>:<Card className="smtp-card smtp-locked"><Mail/><h2>Outgoing email setup</h2><p>Only an administrator can view or change SMTP credentials.</p></Card>}
    </div>
    <Card className="env-help"><AlertTriangle/><div><h3>Environment configuration</h3><p>MongoDB, authentication, JWT, OAuth and encryption keys remain server-only. Set <code>SMTP_ENCRYPTION_KEY</code> in Vercel before saving mail credentials.</p></div></Card>
  </>
}

const blankIam = () => ({ username: '', email: '', password: '', role: 'viewer', permissions: [], active: true })

function IAM({ notice, currentUser }) {
  const [users, setUsers] = useState([]), [requests, setRequests] = useState([]), [form, setForm] = useState(blankIam()), [editing, setEditing] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      const [userRows, signupRows] = await Promise.all([request('/iam/users'), request('/iam/signup-requests')])
      setUsers(userRows); setRequests(signupRows)
    } catch (e) { notice({ type: 'error', text: e.message }) }
  }, [notice])
  useEffect(() => { load() }, [load])
  function start(user) { setEditing(user.id); setForm({ username: user.username, email: user.profile?.email || '', password: '', role: user.role, permissions: user.permissions || [], active: user.active !== false }) }
  function reset() { setEditing(''); setForm(blankIam()) }
  function togglePermission(id) { setForm((old) => ({ ...old, permissions: old.permissions.includes(id) ? old.permissions.filter((value) => value !== id) : [...old.permissions, id] })) }
  async function save(e) {
    e.preventDefault(); setBusy(true)
    try {
      const path = editing ? `/iam/users/${editing}` : '/iam/users', method = editing ? 'PATCH' : 'POST'
      const payload = { ...form }; if (editing && !payload.password) delete payload.password
      await request(path, { method, body: JSON.stringify(payload) })
      notice({ text: editing ? 'IAM user updated.' : 'IAM user created.' }); reset(); await load()
    } catch (e) { notice({ type: 'error', text: e.message }) } finally { setBusy(false) }
  }
  async function removeUser(user) {
    if (!confirm(`Delete IAM user ${user.username}?`)) return
    try { await request(`/iam/users/${user.id}`, { method: 'DELETE' }); notice({ text: `${user.username} deleted.` }); if (editing === user.id) reset(); await load() } catch (e) { notice({ type: 'error', text: e.message }) }
  }
  async function approveSignup(signup) {
    setBusy(true)
    try {
      const user = await request(`/iam/signup-requests/${signup.id}/approve`, { method: 'POST' })
      notice({ text: `${signup.full_name} approved as a Viewer. You can now edit ${user.username}'s role and feature access.` }); await load()
    } catch (e) { notice({ type: 'error', text: e.message }) } finally { setBusy(false) }
  }
  async function rejectSignup(signup) {
    if (!confirm(`Reject the signup request from ${signup.full_name}?`)) return
    setBusy(true)
    try { await request(`/iam/signup-requests/${signup.id}/reject`, { method: 'PATCH', body: JSON.stringify({}) }); notice({ text: `${signup.full_name}'s request was rejected.` }); await load() }
    catch (e) { notice({ type: 'error', text: e.message }) } finally { setBusy(false) }
  }
  const editingUser = users.find((user) => user.id === editing), locked = editingUser?.source === 'environment'
  const openRequests = requests.filter((row) => ['pending', 'oauth_pending'].includes(row.status))
  return <><PageHead eyebrow="Identity & access management" title="IAM" action={<Button icon={Plus} onClick={reset}>New user</Button>} />
    <Card className="security-banner"><span><UserCog/></span><div><h2>MongoDB-backed team access</h2><p>Admins have full control. Custom access grants selected sidebar features. Viewers can browse approved screens but cannot change records.</p></div></Card>
    <Card className="signup-queue">
      <div className="card-title"><div><h2>Signup approval queue</h2><p>Review identity and organisation details before creating an IAM account.</p></div><span className={`badge ${openRequests.length ? 'amber' : 'green'}`}>{openRequests.length} open</span></div>
      {openRequests.length ? <div className="signup-request-grid">{openRequests.map((signup) => <article key={signup.id} className="signup-request-card">
        <div className="signup-request-head"><div className="request-avatar">{signup.full_name?.slice(0,1).toUpperCase()}</div><div><strong>{signup.full_name}</strong><small>@{signup.requested_username} · {signup.job_title || 'Role not provided'}</small></div><span className={`badge ${signup.status === 'pending' ? 'green' : 'amber'}`}>{signup.status === 'pending' ? 'Verified' : 'Awaiting verification'}</span></div>
        <div className="request-contact"><span><Mail/>{signup.email}</span><span><Phone/>{signup.phone}</span><span><MapPin/>{[signup.city,signup.state,signup.country].filter(Boolean).join(', ')}</span></div>
        <div className="request-organisation"><strong>{signup.organization_name}</strong><span>{signup.organization_type} · {signup.team_size || 'Team size not provided'}</span>{signup.use_case && <p>{signup.use_case}</p>}</div>
        <div className="request-meta"><span className="badge blue">{signup.signup_method === 'oauth' ? `${signup.oauth_provider || 'Social'} signup` : 'Password signup'}</span><small>Requested {dateLabel(signup.created_at)}</small></div>
        <div className="request-actions"><Button variant="ghost" disabled={busy} onClick={()=>rejectSignup(signup)}>Reject</Button><Button icon={CheckCircle2} disabled={busy || signup.status !== 'pending'} onClick={()=>approveSignup(signup)}>{signup.status === 'pending' ? 'Approve as viewer' : 'Verification required'}</Button></div>
      </article>)}</div> : <Empty icon={CheckCircle2} title="No signup requests waiting" copy="New password and verified social registrations will appear here."/>}
    </Card>
    <div className="iam-layout"><Card className="table-card"><div className="card-title"><div><h2>Workspace users</h2><p>{users.length} account{users.length === 1 ? '' : 's'} stored in IAM</p></div></div>{users.length ? <div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Features</th><th>PEM</th><th>Status</th><th/></tr></thead><tbody>{users.map((user) => <tr key={user.id} className={editing === user.id ? 'selected-row' : ''}><td><strong>{user.username}</strong><small>{user.profile?.email || (user.source === 'environment' ? 'Vercel environment admin' : user.last_login_at ? `Last login ${dateLabel(user.last_login_at)}` : 'Never signed in')}</small></td><td><span className={`badge ${user.role === 'admin' ? 'blue' : user.role === 'viewer' ? 'amber' : 'green'}`}>{ROLE_LABELS[user.role]}</span></td><td>{user.role === 'admin' ? 'All' : user.permissions?.length || 0}</td><td><span className={`badge ${user.pem?.enabled ? 'green' : 'red'}`}>{user.pem?.enabled ? 'Enabled' : 'Not set'}</span></td><td><span className={`badge ${user.active ? 'green' : 'red'}`}>{user.active ? 'Active' : 'Disabled'}</span></td><td><div className="row-buttons"><Button variant="tiny" onClick={() => start(user)}>Edit</Button>{user.source !== 'environment' && user.id !== currentUser.id && <button className="row-action danger" onClick={() => removeUser(user)} title="Delete user"><Trash2/></button>}</div></td></tr>)}</tbody></table></div> : <Empty icon={UserCog} title="No IAM users found" />}</Card>
      <Card className="iam-form"><div className="card-title"><div><h2>{editing ? `Edit ${form.username}` : 'Create user'}</h2><p>{locked ? 'Managed by server environment variables' : editing ? 'Leave password blank to keep it unchanged' : 'Add a protected workspace account'}</p></div></div><form onSubmit={save}><Field label="Username" value={form.username} disabled={Boolean(editing)} onChange={(e) => setForm({ ...form, username: e.target.value })} required/><Field label="Email for Google / Microsoft" type="email" value={form.email} disabled={locked} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@organisation.com"/><Field label={editing ? 'New password (optional)' : 'Password'} type="password" minLength="8" disabled={locked} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editing}/><Field label="Role" as="select" disabled={locked} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value, permissions: e.target.value === 'custom' ? form.permissions : [] })}><option value="admin">Admin — full access</option><option value="custom">Custom — selected features</option><option value="viewer">Viewer — read only</option></Field>{form.role === 'custom' && <div className="permission-box"><span>Allowed features</span><div className="permission-grid">{FEATURE_OPTIONS.map((feature) => <label key={feature.id}><input type="checkbox" checked={form.permissions.includes(feature.id)} onChange={() => togglePermission(feature.id)} /><span>{feature.label}</span></label>)}</div></div>}<label className="switch-row"><input type="checkbox" checked={form.active} disabled={locked} onChange={(e) => setForm({ ...form, active: e.target.checked })}/><span><strong>Active account</strong><small>Disabled users are signed out and cannot log in.</small></span></label><div className="form-actions">{editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}<Button type="submit" icon={UserCog} disabled={busy || locked}>{busy ? 'Saving…' : editing ? 'Save access' : 'Create user'}</Button></div></form></Card>
    </div>
  </>
}

function Security({ notice }) {
  const [devices, setDevices] = useState([]), [users, setUsers] = useState([]), [userId, setUserId] = useState(''), [generated, setGenerated] = useState(null), [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { const [deviceRows, userRows] = await Promise.all([request('/devices'), request('/iam/users')]); setDevices(deviceRows); setUsers(userRows); setUserId((old) => old || userRows[0]?.id || '') } catch (e) { notice({ type: 'error', text: e.message }) } }, [notice])
  useEffect(() => { load() }, [load])
  async function toggle(device) { try { await request(`/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ active: !device.active }) }); await load() } catch (e) { notice({ type: 'error', text: e.message }) } }
  async function generatePem(e) {
    e.preventDefault(); if (!userId) return
    const user = users.find((row) => row.id === userId)
    if (user?.pem?.enabled && !confirm(`Generate a replacement PEM for ${user.username}? Their current PEM will stop working.`)) return
    setBusy(true); setGenerated(null)
    try {
      const pair = await window.crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
      const [privateDer, publicDer] = await Promise.all([window.crypto.subtle.exportKey('pkcs8', pair.privateKey), window.crypto.subtle.exportKey('spki', pair.publicKey)])
      const safeName = String(user.username || 'user').replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase(), privateName = `${safeName}-private.pem`, publicName = `${safeName}-public.pem`
      const privatePem = pemFromDer(privateDer, 'PRIVATE KEY'), publicPem = pemFromDer(publicDer, 'PUBLIC KEY')
      await request(`/iam/users/${userId}/pem`, { method: 'PUT', body: JSON.stringify({ filename: publicName, pem: publicPem }) })
      setGenerated({ userId, username: user.username, filename: privateName, pem: privatePem }); downloadTextFile(privatePem, privateName)
      notice({ text: `PEM created for ${user.username}. The private key download has started.` }); await load()
    } catch (e) { notice({ type: 'error', text: e.message }) } finally { setBusy(false) }
  }
  async function removePem() { const user = users.find((row) => row.id === userId); if (!user?.pem?.enabled || !confirm(`Remove PEM sign-in for ${user.username}?`)) return; try { await request(`/iam/users/${userId}/pem`, { method: 'DELETE' }); notice({ text: 'PEM sign-in removed.' }); await load() } catch (e) { notice({ type: 'error', text: e.message }) } }
  const selected = users.find((user) => user.id === userId)
  return <><PageHead eyebrow="Access control" title="Security & devices" /><Card className="security-banner"><span><ShieldCheck/></span><div><h2>Authentication security</h2><p>Generate PEM credentials for IAM users and revoke browser sessions. The private key is created locally and downloaded directly to your device.</p></div></Card><div className="security-grid"><Card className="pem-card"><div className="card-title"><div><h2>Generate PEM sign-in</h2><p>Select a workspace user, then generate and download their private key</p></div><span className="pem-icon"><Fingerprint/></span></div><form onSubmit={generatePem}><Field label="IAM user" as="select" value={userId} onChange={(e) => { setUserId(e.target.value); setGenerated(null) }}>{users.map((user) => <option value={user.id} key={user.id}>{user.username} — {ROLE_LABELS[user.role]}</option>)}</Field>{selected?.pem?.enabled && <div className="fingerprint"><span>Registered key</span><strong>{selected.pem.filename}</strong><code>{selected.pem.fingerprint}</code><small>Generated {dateLabel(selected.pem.enrolled_at)}</small></div>}{generated?.userId === userId && <div className="generated-key"><span><KeyRound/></span><div><strong>Private PEM ready</strong><small>Save this file securely. It cannot be recovered after you leave this page.</small></div><Button type="button" variant="secondary" icon={CloudDownload} onClick={() => downloadTextFile(generated.pem, generated.filename)}>Download again</Button></div>}<div className="form-actions">{selected?.pem?.enabled && <Button type="button" variant="danger" onClick={removePem}>Remove key</Button>}<Button icon={KeyRound} disabled={!userId || busy}>{busy ? 'Generating securely…' : selected?.pem?.enabled ? 'Generate replacement PEM' : 'Generate & download PEM'}</Button></div></form></Card><Card className="pem-help"><span className="pem-icon"><LockKeyhole/></span><h2>How PEM login works</h2><ol><li>Select an IAM user and generate their key.</li><li>The private PKCS#8 PEM downloads immediately.</li><li>Only the matching public key and fingerprint are saved in MongoDB.</li><li>At login, the user selects the downloaded private PEM to sign in.</li></ol></Card></div><div className="section-divider"><span>Authenticated device sessions</span></div><Card className="table-card">{devices.length?<div className="table-wrap"><table><thead><tr><th>User</th><th>Method</th><th>Last login</th><th>Status</th><th/></tr></thead><tbody>{devices.map(x=><tr key={x.id}><td><strong>{x.username}</strong><small>{x.user_agent?.slice(0,55)}</small></td><td>{x.login_method}</td><td>{dateLabel(x.last_login_at)}</td><td><span className={`badge ${x.active?'green':'red'}`}>{x.active?'Active':'Revoked'}</span></td><td><Button variant="tiny" onClick={()=>toggle(x)}>{x.active?'Revoke':'Restore'}</Button></td></tr>)}</tbody></table></div>:<Empty icon={ShieldCheck} title="No devices recorded"/>}</Card></>
}

function Backup({reload,notice}){const[file,setFile]=useState(null);async function download(){const token=localStorage.getItem('boutique_token');const r=await fetch('/api/backup',{headers:{Authorization:`Bearer ${token}`}});const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`boutique-backup-${today()}.json`;a.click();URL.revokeObjectURL(url);notice({text:'Backup downloaded.'})}async function restore(){if(!file||!confirm('Insert all records from this backup? Duplicates may result.'))return;try{const data=JSON.parse(await file.text());const r=await request('/restore',{method:'POST',body:JSON.stringify(data)});notice({text:`Restore complete: ${r.inserted} records inserted.`});reload()}catch(e){notice({type:'error',text:e.message})}}return <><PageHead eyebrow="Data resilience" title="Backup & restore" /><div className="backup-grid"><Card className="backup-card"><span className="backup-icon blue"><CloudDownload/></span><h2>Download checkpoint</h2><p>Export sales, work notes, bills, devices and settings in one JSON checkpoint.</p><Button icon={CloudDownload} onClick={download}>Download backup</Button></Card><Card className="backup-card"><span className="backup-icon green"><Upload/></span><h2>Restore checkpoint</h2><p>Insert records from a previously downloaded application checkpoint.</p><input type="file" accept="application/json" onChange={e=>setFile(e.target.files[0])}/><Button variant="secondary" icon={ArchiveRestore} disabled={!file} onClick={restore}>Restore backup</Button></Card></div><Card className="env-help danger-help"><AlertTriangle/><div><h3>Restore is additive</h3><p>Existing records are preserved. Restoring the same checkpoint more than once can create duplicates.</p></div></Card></>}

export default function App() {
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem('boutique_user')) } catch { return null } })
  function logout() { localStorage.removeItem('boutique_token'); localStorage.removeItem('boutique_user'); setUser(null) }
  useEffect(() => {
    if (!user || !localStorage.getItem('boutique_token')) return
    request('/auth/me').then((current) => { localStorage.setItem('boutique_user', JSON.stringify(current)); setUser(current) }).catch(logout)
  }, [])
  return user ? <Shell user={user} logout={logout} /> : <PublicHome onLogin={setUser} />
}
