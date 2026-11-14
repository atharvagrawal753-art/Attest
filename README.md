# Attest backend

TypeScript API for the Attest console (AICTE approval workflow, compliance monitoring and alert management, PS 2026262).
It serves the unchanged frontend from `public/index.html` and implements every endpoint that page calls.

## Run

```bash
npm install
npm run dev                  # http://localhost:3000 (tsx, auto-reload)
npm test                     # 25 tests (vitest + supertest)
npm run build && npm start   # compiled JavaScript in dist/
docker build -t attest .
docker run -p 3000:3000 -e JWT_SECRET=<32+ chars> -e DEMO_MODE=false attest
```

Open the page, press **Run scrutiny**, then try Approve / Request correction / Reject. Approve is blocked (409)
because the fire safety certificate is missing. To watch escalation live, start with
`ALERT_SCAN_SECONDS=5 ESCALATION_AFTER_MINUTES=1`.

## Architecture

```
src/
  config/        zod-validated environment, fails fast on bad or unsafe settings
  domain/        pure logic, no I/O: workflow state machine, checklist, scrutiny + rule engine
  services/      CaseService, AlertEngine (scan, dedupe, auto-resolve, escalate), AuditService (hash chain),
                 TokenService (JWT) + TicketStore (SSE), permissions (RBAC), EventHub (SSE)
  repositories/  ports (interfaces) + in-memory / filesystem adapters
  routes/        HTTP layer: zod validation, thin handlers
  middleware/    request id, auth, error envelope, structured access logs
tests/           engine, audit tamper detection, API contract, alert escalation
```

Services depend on repository interfaces, so replacing the in-memory adapters with PostgreSQL needs no change to
business logic.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/session/demo` | Demo session (JWT). Only when `DEMO_MODE=true` |
| GET | `/api/cases`, `/api/cases/:id` | Applications, stage, statutory deadline |
| GET | `/api/cases/:id/preview` | Compare documents, nothing stored |
| POST | `/api/cases/:id/scrutiny` | Run scrutiny, advance stage, audit |
| GET | `/api/cases/:id/report` | Last stored report |
| POST | `/api/cases/:id/decision` | Approved / Correction requested / Rejected, with reason |
| POST | `/api/cases/:id/documents` | Upload PDF/JPG/PNG (base64), SHA-256 recorded |
| POST | `/api/cases/:id/resubmit` | Institution resubmits after corrections |
| GET | `/api/cases/:id/audit?limit=` | Audit entries |
| GET | `/api/audit/verify` | Verify the hash chain |
| GET | `/api/alerts?status=&limit=` | Alerts (active, open, acknowledged, resolved, all) |
| POST | `/api/alerts/:id/acknowledge` | Stop escalation |
| POST | `/api/stream-ticket`, then GET `/api/alerts/stream?ticket=` | Live alerts over SSE |
| POST | `/api/demo/reset` | Restore demonstration data (demo mode only) |
| GET | `/api/health`, `/api/ready` | Liveness / readiness (readiness fails if the audit chain is broken) |

Errors share one shape: `{ "error": { "code", "message", "details?", "requestId" } }`.

## Behaviour worth knowing

- **Workflow** is a state machine (Submitted, Scrutiny, Expert review, then Approved / Rejected / Correction requested). Illegal moves return 409.
- **Approval gate**: approval is re-checked at decision time. A missing mandatory document returns 409. Only a
  `competent_authority` can override, with a written reason of 20+ characters, and the override is audited.
- **Audit trail**: each entry stores the SHA-256 of the previous one. Editing or deleting history is detected by `/api/audit/verify`.
- **Alerts**: stage overdue / due soon, certificate expiring, compliance lapse. Deduplicated, auto-resolved when the
  condition clears, and escalated Scrutiny officer, Regional officer, Member Secretary until someone acknowledges.
- **Security**: HS256 JWT with issuer and audience, RBAC, institution users scoped to their own application, Helmet + CSP,
  rate limits, body size limits, magic-byte checks on uploads, single-use 30 second SSE tickets (no token in URLs).

## Before real use

- Persistence is in memory. Add PostgreSQL adapters for the three repository interfaces (and S3 for `BlobStore`).
- Field extraction is not OCR. Uploaded files are hashed and stored, and field values come from `declaredFields`.
  Plug a real extractor in at `CaseService.addDocument`.
- Replace the demo session with real identity (SSO/OIDC). Set `DEMO_MODE=false` and a 32+ character `JWT_SECRET`;
  production refuses to start otherwise.
- Statutory timelines and `MIN_FACULTY` are illustrative defaults. Set them to the current AICTE norms.
- The CSP allows `'unsafe-inline'` because the page has inline scripts. Move them to files to tighten it.
