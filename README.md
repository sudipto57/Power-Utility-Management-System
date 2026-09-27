# Power Utility Management System

Starter full-stack implementation for a utility billing and outage management workflow.

## Stack

- **Database:** PostgreSQL (3NF schema + PL/pgSQL billing function + anomaly/audit triggers)
- **Backend:** Node.js + TypeScript + Express with JWT + RBAC
- **Frontend:** React + Tailwind CSS + Recharts + jsPDF
- **Orchestration:** Docker Compose

## Repository Layout

- `/database/migrations/001_init.sql` – schema, stored function, and triggers
- `/database/seeds/001_seed.sql` – initial topology/tariff/readings seed data
- `/backend` – REST APIs for consumers, meter readings, invoices, payments, outages, work orders
- `/frontend` – consumer portal + admin analytics dashboard
- `/docker-compose.yml` – local end-to-end startup

## Run with Docker

```bash
docker compose up --build
```

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`

## Demo Login Roles

- Admin: `admin / admin123`
- Billing Clerk: `billing / billing123`
- Field Technician: `tech / tech123`
- Consumer: `consumer / consumer123`

## API Highlights

- `POST /api/auth/login`
- `GET|POST /api/consumers`
- `POST /api/meter-readings`
- `POST /api/invoices/generate`
- `GET /api/invoices`
- `POST /api/payments`
- `POST /api/outages`
- `POST /api/work-orders`
- `GET /api/analytics/overview`

## Notes

- Meter reading anomaly trigger marks records where reading variance exceeds 50% from prior reading.
- Financial changes on `invoices` and `payments` are auto-audited in immutable `financial_audit_logs`.
- Monthly bills use slab tariff lookup + subsidy and overdue penalty logic through `generate_monthly_invoice`.
