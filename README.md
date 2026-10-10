# Mitra AI

Multi-agent Intent Translator and Retail Assistant.

Mitra AI is a voice-first grocery assistant designed for elderly users in India (Hindi, Hinglish, English). It converts messy voice/text into structured purchase flows, applies geriatric health guardrails, compares vendor options, pauses for human confirmation, and finalizes purchases with idempotency and audit logs.

## Highlights

- Clerk sign-in, then a 5-step onboarding: language → details → health → family → voice
- Profiles, orders and audit logs in Supabase (Postgres), one profile per signed-in user
- Voice + text input with Web Speech API
- 8-agent LangGraph orchestration
- Health guardrails from each user's own profile (conditions, medicines, allergies + bulk protection)
- HITL pause/resume before purchase
- Simulated MCP search integrations (Zepto + Amazon)
- Real-time agent timeline over WebSocket
- Redis event brokering + DB audit/order persistence
- Mac-style UI (San Francisco system font, Inter fallback) with dark mode, order history and "Order again"

## Architecture

### Backend (FastAPI + LangGraph)

1. Intent Agent
2. Health & Memory Guardrail Agent
3. Planning Agent
4. Search Agent (simulated MCP)
5. Comparison Agent
6. Decision & HITL Agent
7. Purchase Agent (retries + idempotency)
8. Notification Agent

### Frontend (Next.js)

- Split screen:
  - Left: User interaction workspace
  - Right: Developer console timeline
- Tabs:
  - Assistant
  - About Project
  - Uses
- Voice UI:
  - Mic orb
  - Listening status
  - Waveform animation
- Utility controls:
  - Clear workspace
  - See history
  - Clear history

## Tech Stack

- Backend: Python 3.11+, FastAPI, LangGraph, LangChain, SQLAlchemy
- Frontend: Next.js (App Router), TailwindCSS, Web Speech API
- Auth: Clerk (frontend sign-in; backend verifies session tokens against Clerk's JWKS)
- Data: Supabase Postgres (profiles/orders/audit; SQLite fallback for local dev), Redis (event stream)
- Infra: Docker + Docker Compose

## Repository Structure

```text
backend/
  app/
    agents/
    api/
    core/
    graph/
    services/
frontend/
  app/
  components/
docker-compose.yml
README.md
```

## Sign-in (Clerk) and database (Supabase)

### User flow

1. **Sign up / sign in** (`/sign-in`, `/sign-up`): Clerk, styled like the app. Every other page requires a session.
2. **Onboarding** (first visit only): Language → Your details (name, age, phone, address, stores, payment) →
   Health (conditions, medicines, allergies, diet notes) → Family contacts → Voice (mic test, script, read-aloud).
3. **Assistant**: orders are checked against *this user's* health profile; payment is picked on the approval card.
4. **Order History**: placed orders from the database, with **Order again**. **Profile** edits any onboarding step.

### Clerk setup

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com) (enable Email and/or Phone sign-in).
2. `frontend/.env.local`: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (see `frontend/.env.example`).
3. `backend/.env`: the same `CLERK_PUBLISHABLE_KEY` (the backend derives the issuer from it), and
   `CLERK_AUTHORIZED_PARTIES` = the frontend origin(s).

Without keys, Clerk runs in *keyless* dev mode with temporary keys (saved in `frontend/.clerk/`); claim them from
the "Configure your application" prompt or replace them with your own.

### Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Project → **Connect** → copy the **Session pooler** connection string into `backend/.env` as `DATABASE_URL`.
3. Start the backend: tables are created on startup, existing tables gain any new columns, and row level security
   is switched on with no policies, so Supabase's public API keys can't read health data. Only the backend's
   database connection can.

Without `DATABASE_URL` the backend uses a local SQLite file (`backend/mitra_ai.db`).

### Online payment (Razorpay)

1. Sign up at [dashboard.razorpay.com](https://dashboard.razorpay.com), stay in **Test mode**, then
   **Account & Settings → API Keys → Generate test key**.
2. `backend/.env`: `RAZORPAY_KEY_ID=rzp_test_...` and `RAZORPAY_KEY_SECRET=...`.
3. "Pay now (UPI / card)" then appears in onboarding and on the approval card. Flow: the server computes the
   amount from the order → creates a Razorpay order → Checkout opens → the server verifies Razorpay's signature →
   the order is placed for exactly the picks that were paid for. If the purchase fails after payment, it is refunded.
4. Test cards / UPI: see [Razorpay test details](https://razorpay.com/docs/payments/payments/test-card-details/)
   (e.g. UPI `success@razorpay`). Switch to live keys only after Razorpay activates your account (KYC).

### Order alerts (email + SMS)

After each placed order, Mitra alerts the user and (if enabled) their family contacts. Each channel is off until
its keys are set, and a failed alert never affects the order.

- **Email (Resend):** [resend.com](https://resend.com) → API Keys → `RESEND_API_KEY`. Until you verify a domain,
  Resend only delivers from `onboarding@resend.dev` to your own Resend account email.
- **SMS (Twilio):** [console.twilio.com](https://console.twilio.com) → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  and a Twilio number as `TWILIO_FROM_NUMBER`. Trial accounts only text verified numbers; sending to Indian
  numbers in production requires DLT registration.

### Tests

```bash
cd backend && uv pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q tests
```

## Quick Start (Docker)

### 1. Prerequisites

- Docker Desktop running
- Ports available:
  - `3000` (frontend)
  - `8000` (backend)
  - `6379` (redis)
  - `5432` or custom mapped host port (postgres)

If `5432` is busy, map DB host port to `5433:5432` in `docker-compose.yml`.

### 2. Build and Run

```bash
docker compose up --build
```

### 3. Open

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:8000/health`

## Environment Variables

### Backend

- `DATABASE_URL` (Supabase session pooler URL; SQLite if unset)
- `CLERK_PUBLISHABLE_KEY` (or `CLERK_ISSUER`), `CLERK_AUTHORIZED_PARTIES`
- `REDIS_URL`
- `LLM_PROVIDER` (`mock` or `openai`)
- `OPENAI_API_KEY` (optional)

### Frontend

- `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`

## API Reference

Every endpoint except `/health` and `/api/v1/voice/status` needs `Authorization: Bearer <Clerk session token>`
(WebSockets take it as `?token=`). The user comes from the token, never from the request body.

### Profile

- `GET /api/v1/profile/me`: the signed-in user's profile (`404` = onboarding not done)
- `PUT /api/v1/profile/me`: create/update it

### Order history

`GET /api/v1/orders/history`: the user's placed orders, newest first

### Start order

`POST /api/v1/orders/start`

```json
{
  "message": "jaldi 2 packet oats mangao"
}
```

Possible statuses:

- `awaiting_confirmation`
- `completed`

### Resume order

`POST /api/v1/orders/{thread_id}/resume`

```json
{
  "approved": true,
  "payment_method": "cod"
}
```

### WebSocket timeline

`ws://localhost:8000/ws/events/{thread_id}?token=<session token>` (only the user who started the order)

Event payload format:

```json
{
  "event": "agent_completed",
  "agent_name": "Intent Agent",
  "data": {},
  "thread_id": "..."
}
```

## Voice Input

- One mode for Hindi, English and Hinglish (recognition runs in `hi-IN`, which also hears English words).
- Text can be shown in Roman (`jaldi do packet oats`) or Devanagari (`जल्दी दो पैकेट ओट्स`).
- Nothing is sent automatically: the spoken text stays in an editable box with a **"Mitra understood"** card
  (item, quantity, size, urgency from `POST /api/v1/orders/parse`), optionally read back aloud.
- Works in every modern browser:
  - Chrome, Edge, Safari: the browser's own speech recognition, words appear live.
  - Firefox, Brave and others: the mic is recorded in the page and transcribed by the backend
    (`POST /api/v1/voice/transcribe`, 16 kHz mono WAV) using OpenAI if `OPENAI_API_KEY` is set, otherwise
    offline Vosk models: Hindi and Indian English both run, and the transcript with the most recognisable
    grocery words, numbers and units wins.
- Local setup for the offline models (Docker downloads them automatically):

```bash
cd backend && mkdir -p models && cd models
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip && unzip vosk-model-small-hi-0.22.zip
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip && unzip vosk-model-small-en-in-0.4.zip
```

## Data Model Notes

- One `user_profiles` row per Clerk user (id = Clerk user id), written by onboarding.
- Orders table uses unique idempotency key to prevent duplicate purchase writes.
- Audit log captures per-agent events and payloads.

## Frontend UX Notes

- Hydration-safe theme handling
- Dark mode with persistent preference
- Clear workspace without page refresh
- Order history loaded from the database, so it follows the user across devices
- Timeline cards for each agent event in real time

## Troubleshooting

### Hydration error in Next.js

- Fixed by:
  - moving browser-only checks to `useEffect`
  - adding `suppressHydrationWarning` on `<html>` in layout

### Port already allocated (PostgreSQL)

- Update compose DB ports to:

```yaml
ports:
  - "5433:5432"
```

### `next: command not found`

- If running locally (without Docker), install frontend deps:

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

## Viva Demo Script (2-3 mins)

1. Open UI and mention the split-screen architecture.
2. Speak: `jaldi 2 packet oats mangao`.
3. Show live agent timeline on right.
4. Demonstrate HITL pause and approval.
5. Show completion notification and history panel.
6. Switch to About/Uses tabs and dark mode.

## Terms and Contact

Mitra AI recommendations are assistive and for demonstration purposes. Validate order details before confirmation. Health suggestions are general guardrails and do not replace medical advice.

For queries, contact founding team:

- Disha Dutta
- dishadutta61@gmail.com
