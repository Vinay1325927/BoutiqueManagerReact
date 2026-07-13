# Shree Krishna Boutique — React edition

A React single-page application with an Express API and focused Python PDF services. MongoDB and AI credentials remain server-side.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` automatically creates a small `.venv` containing only the passbook and billing PDF packages. Streamlit is not installed.

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

Without `MONGO_URI`, the local API uses temporary in-memory storage so the application can be previewed. For persistent data, set `MONGO_URI` and `MONGO_DB` in `.env`.

The development login defaults to `admin` / `admin` when neither `PASSWORD` nor `PASSWORD_HASH` is configured. Always set `JWT_SECRET`, `USERNAME`, and a production password before deployment.

## Deploy to Vercel

Import this repository into Vercel. The included `vercel.json` builds the Vite frontend, deploys Express as a Node.js Function, and deploys passbook/bill processing as a separate Python Function.

Add every required value from `.env.example` under **Project Settings → Environment Variables**. At minimum configure `MONGO_URI`, `MONGO_DB`, `JWT_SECRET`, `BRIDGE_SECRET`, `USERNAME`, and either `PASSWORD` or `PASSWORD_HASH`.

Passbook extraction and bill PDF generation are handled by `server/python_bridge.py`. Local development uses `.venv`; Vercel installs the minimal packages from `requirements.txt` for `api/pdf.py`.

## Included workflows

- Public sale entry and protected admin login
- Sales CRUD and partial-payment collection
- Customer and vendor summaries
- Billing with downloadable PDF invoices
- Revenue, profit, category, customer, and payment analytics
- Pending-payment reminders
- Passbook PDF text extraction
- Work notes
- Gemini or OpenAI business assistant
- Device-session review and revocation
- Complete JSON backup and additive restore
- Excel account export
- Responsive light and dark interfaces

The application entry points are `src/main.jsx`, `api/index.js`, and `api/pdf.py`.
# BoutiqueManagerReact
