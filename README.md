# Shree Krishna Boutique — React edition

The original Streamlit application has been rebuilt as a React single-page application with an Express API. MongoDB and AI credentials remain server-side.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

Without `MONGO_URI`, the API uses temporary in-memory storage so the application can be previewed immediately. For persistent data, set `MONGO_URI` and `MONGO_DB` in `.env`. The API also reads the original Streamlit `credentials/.env`; values in the root `.env` take precedence when both files exist.

The development login defaults to `admin` / `admin` when neither `PASSWORD` nor `PASSWORD_HASH` is configured. Always set `JWT_SECRET`, `USERNAME`, and a production password before deployment.

## Production

```bash
npm run build
npm start
```

Express serves the compiled React application from `dist/` and exposes the protected API under `/api`.

## Included workflows

- Public sale entry and protected admin login
- Sales CRUD and partial-payment collection
- Customer and vendor summaries
- Billing with downloadable PDF invoices
- Revenue, profit, category, customer, and payment analytics
- Pending-payment reminders
- Inventory tracking and low-stock status
- Passbook PDF text extraction
- Work notes
- Gemini or OpenAI business assistant
- Device-session review and revocation
- Complete JSON backup and additive restore
- Excel account export
- Responsive light and dark interfaces

The previous Python files are retained as a migration reference. The active application entry points are `src/main.jsx` and `server/index.js`.
