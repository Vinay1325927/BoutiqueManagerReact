# Boutique Cloud

A public, multi-tenant boutique operations product built with React, Express, MongoDB, and focused Python PDF services.

Every public signup immediately creates a private workspace and signs its owner in. Business collections are scoped by `workspace_id`, so one customer cannot read or change another customer’s sales, notes, bills, vendors, passbook records, or AI context.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`; the API runs on `http://localhost:8787`. Without `MONGO_URI`, local development uses temporary in-memory storage. `npm run dev` creates a small Python environment containing only the passbook and billing packages.

The local administrator defaults to `Admin` / `admin` only when no password is configured. Production fails closed if neither `PASSWORD` nor `PASSWORD_HASH` is present.

## Deploy to Vercel

Import the repository and add the values from `.env.example` under **Project Settings → Environment Variables**. Required production values are:

```text
MONGO_URI=...
MONGO_DB=boutique_db
JWT_SECRET=...
BRIDGE_SECRET=...
USERNAME=Admin
PASSWORD=...
BOUTIQUE_USERNAME=...
BOUTIQUE_NAME=...
SMTP_ENCRYPTION_KEY=...
```

Keep the platform password and all other secrets in Vercel; never commit them. The account named by `USERNAME` is the only platform administrator. Its interface and API access are limited to the private **Customer accounts** console with registration details, workspace status, activity, record counts, revenue, pending value, login history, and estimated MongoDB document usage. Stale environment administrators are disabled automatically.

When `BOUTIQUE_USERNAME` and `BOUTIQUE_NAME` are set, the server creates a separate owner workspace for the platform owner’s own boutique. It intentionally reuses the platform `PASSWORD` or `PASSWORD_HASH`, while receiving the standard business tools plus the private Technical and SMTP page. Public customer workspaces do not receive Technical access. Existing legacy business records assigned to the old platform workspace are migrated into this boutique automatically.

Public password signups require contact, organisation, and location details. There is no approval queue: successful signup creates a workspace owner account immediately. Customer owners never see the platform console, internal IAM, security devices, SMTP credentials, or other workspaces.

### Google and Microsoft login

Configure these server-only variables when social login is required:

```text
ADMIN_EMAIL=admin@your-company.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=common
OAUTH_REDIRECT_BASE=https://your-production-domain.vercel.app
```

Register these callbacks with the providers:

```text
https://your-production-domain.vercel.app/api/auth/oauth/google/callback
https://your-production-domain.vercel.app/api/auth/oauth/microsoft/callback
```

An existing verified identity signs in. A new identity completes the remaining organisation questions, then receives its private workspace immediately.

### Gmail / SMTP

Set a stable `SMTP_ENCRYPTION_KEY`, redeploy, then use **Technical → Outgoing email · SMTP** from the platform administrator account. Gmail requires 2-Step Verification and a Google App Password. SMTP passwords are AES-256-GCM encrypted before MongoDB storage.

## Main workflows

- Immediate public password, Google, and Microsoft signup
- Tenant-isolated MongoDB business data
- Platform-only customer and usage console
- Sales and repeat-customer orders
- Collections, customers, vendors, analytics, and reminders
- Downloadable PDF bills and permanent bill history
- Python passbook PDF extraction
- Work notes and AI business assistant
- Internal Custom and Viewer support identities
- Browser-generated PEM login and device revocation
- JSON backup/restore and Excel exports
- Responsive light and dark interfaces

The application entry points are `src/main.jsx`, `api/index.js`, and `api/pdf.py`.
