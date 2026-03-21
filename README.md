# Mitra AI

Multi-agent Intent Translator and Retail Assistant.

Mitra AI is a voice-first grocery assistant designed for elderly users in India (Hindi, Hinglish, English). It converts messy voice/text into structured purchase flows, applies geriatric health guardrails, compares vendor options, pauses for human confirmation, and finalizes purchases with idempotency and audit logs.

## Highlights

- Voice + text input with Web Speech API
- 8-agent LangGraph orchestration
- Geriatric safety guardrails (diabetes/hypertension + bulk protection)
- HITL pause/resume before purchase
- Simulated MCP search integrations (Zepto + Amazon)
- Real-time agent timeline over WebSocket
- Redis event brokering + DB audit/order persistence
- White-pink premium UI with dark mode, tabs, clear/history controls

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
- Data: PostgreSQL (profiles/orders/audit), Redis (event stream)
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

- `DATABASE_URL` (default postgres in compose)
- `REDIS_URL`
- `LLM_PROVIDER` (`mock` or `openai`)
- `OPENAI_API_KEY` (optional)

### Frontend

- `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`)

## API Reference

### Start order

`POST /api/v1/orders/start`

```json
{
  "user_id": "dadaji-001",
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
  "user_id": "dadaji-001",
  "approved": true
}
```

### WebSocket timeline

`ws://localhost:8000/ws/events/{thread_id}`

Event payload format:

```json
{
  "event": "agent_completed",
  "agent_name": "Intent Agent",
  "data": {},
  "thread_id": "..."
}
```

## Data Model Notes

- Seed user profile is created on backend startup:
  - `dadaji-001`
  - Age: `75`
  - Conditions: `diabetes`, `hypertension`
- Orders table uses unique idempotency key to prevent duplicate purchase writes.
- Audit log captures per-agent events and payloads.

## Frontend UX Notes

- Hydration-safe theme handling
- Dark mode with persistent preference
- Clear workspace without page refresh
- Session history persisted in local storage
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
