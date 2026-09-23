# OpsWatch: Project Overview

> This is a living document. It describes what we're building, why each part exists,
> and how the parts fit together. When a decision changes, update this file and
> record the reasoning in `docs/decisions/`.

---

## 1. What OpsWatch is

OpsWatch is a backend service that **receives events from other systems, stores them,
evaluates rules against them, and reliably notifies someone when a rule matches.**

An "event" is any small fact another system wants to report:

- "Deployment `v2.3.1` of `payments-api` finished"
- "CI pipeline `main` failed"
- "Error rate on `checkout` is above 5%"
- "Payment `pay_123` was refunded"

Users configure **rules** ("when `service = payments` and `severity = critical`...") and
**destinations** ("...POST it to this webhook URL"). OpsWatch makes sure the
notification is delivered, retries when the destination is down, and lets users see
exactly what happened.

It's a small version of the core of products like PagerDuty, Sentry alerting, the
Stripe webhooks system, or Datadog monitors.

---

## 2. Why this project (the real goal)

The product is the vehicle. The goal is to **learn and prove backend engineering
skills** that hiring managers test for and that CRUD apps never touch:

| Skill that interviews probe | Where OpsWatch forces you to deal with it |
|---|---|
| HTTP and API design | Plain `node:http` server, versioned public API, error format |
| Data modeling and SQL | Multi-tenant schema, indexes, partitioning, transactions |
| Asynchronous processing | The API accepts events quickly; workers process them later |
| Reliability | Retries, idempotency, dead-letter state, crash safety |
| Security | Password auth, API keys, tenant isolation, signed webhooks, SSRF |
| Observability | Structured logs, traces across API → DB → worker, metrics |
| Performance | Load tests with real numbers, finding and fixing bottlenecks |
| Operations | Docker, CI, deployment, graceful shutdown, health checks |

Every feature below is included because it teaches one of these skills. If a feature
doesn't, it's out of scope.

**The finished result should let you say:** *"I built a multi-tenant event ingestion
and webhook delivery system in Node and Postgres. It handles X events/sec at p99 Y ms.
Here's how it avoids losing or duplicating work when processes crash, and here are the
trade-offs I chose."*

---

## 3. The product, told as a story

1. **Ana signs up** in the dashboard with an email and password. She creates an
   organization called "Acme".
2. She **creates an API key** for Acme. OpsWatch shows the key once (`ow_live_...`) and
   stores only a hash of it.
3. She **adds a destination**: a webhook URL, `https://hooks.acme.dev/opswatch`.
   OpsWatch generates a signing secret so Acme can verify requests really came from
   OpsWatch.
4. She **creates a rule**: "if `type = deploy.failed` → send to that webhook".
5. Acme's CI system **sends an event**:
   `POST /v1/events` with the API key, an `Idempotency-Key` header, and a JSON body.
6. OpsWatch **validates, stores, and acknowledges** the event in a few milliseconds
   with `202 Accepted`. It does *not* call the webhook during that request.
7. A **worker** picks up the event, evaluates Acme's rules, finds a match, and creates a
   **delivery**.
8. The worker **sends the webhook**. Acme's server is down and returns `503`. The
   attempt is recorded, and a retry is scheduled with exponential backoff.
9. Ten minutes later the retry succeeds. Ana opens the dashboard and sees the event,
   the rule that matched, and both delivery attempts with their status codes and
   latency.
10. If every attempt had failed, the delivery would be marked **dead**, and Ana could
    click **Replay** after fixing her endpoint.

---

## 4. Core concepts (glossary)

| Term | Meaning |
|---|---|
| **User** | A person who logs into the dashboard. |
| **Organization (org / tenant)** | The unit of ownership. All data belongs to exactly one org. Users are members of orgs. |
| **Membership** | Links a user to an org with a role (`owner`, `member`). |
| **Session** | Proves a *browser user* is logged in. Stored server-side and identified by an opaque cookie. |
| **API key** | Proves a *machine* is allowed to send events for an org. Shown once; stored hashed. |
| **Event** | An immutable fact sent by a client: type, source, severity, payload, timestamp. |
| **Idempotency key** | A client-chosen ID that makes retrying a request safe. The same key means the same result, never a duplicate. |
| **Job** | A unit of background work, such as "process event 123" or "deliver delivery 456". |
| **Rule** | A condition plus a destination. It's evaluated against every event in its org. |
| **Destination** | Where notifications go. For now that's a webhook URL with a signing secret. |
| **Delivery** | "This event must reach this destination." It has a state: `pending → succeeded` or `pending → dead`. |
| **Delivery attempt** | One HTTP call made for a delivery, with its status code, latency, and error. |
| **Dead letter** | A delivery or job that exhausted its retries. It's kept for inspection and manual replay. |

---

## 5. Architecture

### 5.1 Components

```
                    ┌──────────────────────┐
  Browser  ───────► │                      │
  (dashboard,       │      API process     │
   session cookie)  │   (node:http server) │
                    │                      │
  Client systems ─► │  POST /v1/events     │
  (API key)         └──────────┬───────────┘
                               │  one transaction:
                               │  insert event + insert job
                               ▼
                    ┌──────────────────────┐
                    │      PostgreSQL      │  ◄── source of truth:
                    │ events, jobs, rules, │      data AND the job queue
                    │ deliveries, users... │
                    └──────────┬───────────┘
                               │  workers claim jobs
                               │  (FOR UPDATE SKIP LOCKED)
                               ▼
                    ┌──────────────────────┐        ┌───────────────────┐
                    │   Worker process(es) │ ─────► │ Customer webhooks │
                    │ evaluate rules,      │ HTTPS  │ (external, often  │
                    │ send webhooks, retry │        │  slow or broken)  │
                    └──────────────────────┘        └───────────────────┘

        Redis: rate limiting (added in flow 11)
        OpenTelemetry + Grafana: traces, metrics, logs (added in flow 9)
```

There are **two separate processes built from the same codebase**:

- **API**: handles HTTP. It must stay fast and never wait on external systems.
- **Worker**: does the slow, unreliable work (webhooks). You can run and scale it
  separately, and a crashing webhook call can't affect the API.

### 5.2 The life of one event

```
Client ── POST /v1/events ──► API
  1. Authenticate API key               → which org is this?
  2. Rate-limit check                   → is this org sending too much?
  3. Validate body                      → reject bad input with 400, never store garbage
  4. BEGIN transaction
       insert event (unique on org + idempotency key)
       insert job "process_event"
     COMMIT                             → both rows exist, or neither does
  5. Respond 202 Accepted { id }        → the client is done, typically in under 20 ms

Worker (loop)
  6. Claim a due job (SKIP LOCKED)      → two workers never take the same job
  7. process_event: load the org's rules, evaluate them,
     create a delivery + "deliver" job for each match
  8. deliver: sign payload, POST with a timeout, record the attempt
       2xx            → delivery succeeded
       5xx / timeout  → schedule retry (backoff + jitter)
       too many tries → delivery dead
  9. Mark job done
```

### 5.3 Why the API doesn't call the webhook directly

If the API sent the webhook inside the request:

- A slow customer endpoint (10 s timeout) would make *our* API slow.
- If the endpoint is down, we'd either fail the client's request or lose the
  notification.
- A traffic burst would open thousands of outgoing connections at once.

Separating **accepting work** from **doing work** is the most important idea in the
project. The queue sits between them: the API writes to it quickly, and workers take
from it at a steady rate.

### 5.4 Why Postgres is the queue (at first)

The first versions use a `jobs` table instead of Redis/BullMQ, for these reasons:

- **Atomicity for free.** The event and its job are written in the *same transaction*.
  With a separate queue there's a gap: "event saved, then the process crashed before
  enqueueing" means the event is never processed. Solving that gap is exactly what
  the **outbox pattern** does. We avoid needing it at first, and we learn it properly
  in flow 13.
- **Fewer moving parts.** One database to run, back up, and understand.
- **`SELECT ... FOR UPDATE SKIP LOCKED`** lets many workers claim different jobs
  safely. It's a well-known production pattern, used by tools like GoodJob, Oban,
  and pg-boss.

Its limits are real: polling load and throughput limited by the database. Flow 11
measures them, and flow 13 moves to Redis/BullMQ, with a written explanation of when
the switch is worth it.

---

## 6. Why each piece exists

| Piece | Problem it solves | What happens without it |
|---|---|---|
| **Plain `node:http` + tiny router** | Learn what frameworks do: routing, body parsing, limits, errors | You can use Express but can't explain what it does for you |
| **Config validation (Zod)** | The app fails at startup if env vars are wrong | It crashes at 3 a.m. on the first request that reads a missing variable |
| **Structured logs (Pino, JSON)** | Logs you can search by `requestId`, `orgId`, `jobId` | Plain-text logs that are impossible to filter in production |
| **Request ID** | Ties every log line for one request together | Debugging concurrent requests by guesswork |
| **Graceful shutdown** | On deploy, finish in-flight requests and jobs, then exit | Every deploy drops requests and half-finishes jobs |
| **Health endpoints** | `/healthz` (process alive), `/readyz` (can reach DB) for Docker or the orchestrator | Traffic is sent to an instance that can't serve it |
| **Migrations (plain SQL files)** | Versioned, repeatable schema changes | "Works on my machine" databases |
| **Sessions (cookie)** | Browser auth that can be revoked instantly | JWTs in localStorage: hard to revoke and exposed to XSS |
| **Hashed API keys** | Machine auth; a leaked DB doesn't leak working keys | Plaintext keys in the DB |
| **`org_id` on every row and query** | Tenant isolation | One customer sees another's data: the worst multi-tenant bug |
| **Idempotency keys** | Clients can safely retry after a network error | Duplicate events and duplicate alerts |
| **Jobs table + worker** | Async processing, retries, backpressure | Slow API, lost work on failures |
| **Exponential backoff + jitter** | Retries don't hammer a struggling endpoint all at once | A thundering herd keeps the endpoint down |
| **Dead-letter + replay** | Failures are visible and recoverable | Work silently disappears |
| **HMAC-signed webhooks** | Receivers can verify requests came from us and weren't replayed | Anyone can forge alerts to customers |
| **SSRF protection** | Customers can't point webhooks at our internal network | An attacker reads cloud metadata or internal services through our worker |
| **Circuit breaker per destination** | One dead endpoint doesn't eat all worker capacity | One bad customer slows delivery for everyone |
| **OpenTelemetry tracing** | See one event's path: HTTP → DB → job → webhook | Performance and debugging questions can't be answered |
| **Rate limiting (Redis)** | One noisy org can't overload the system | A single client can take the service down |
| **Table partitioning + retention** | The events table stays fast as it grows; old data is cheap to drop | Slow queries and very slow `DELETE`s after a few months |
| **k6 load tests** | Real numbers instead of guesses | "It should be fast" with nothing to back it up |
| **Docker Compose** | Whole stack runs with one command | Onboarding and reviewers give up |
| **CI (GitHub Actions)** | Tests run against a real Postgres on every push | Broken main branch, no signal of quality |

---

## 7. Data model (first sketch)

```
users ──< memberships >── organizations
                               │
          ┌──────────┬─────────┼──────────────┬──────────────┐
          ▼          ▼         ▼              ▼              ▼
      api_keys    events     rules ──► destinations     audit_log
                     │         │
                     └────┬────┘
                          ▼
                     deliveries ──< delivery_attempts

  sessions  (belongs to a user)
  jobs      (generic queue: type, payload, run_at, attempts, status, locked_by, locked_until)
```

Key design rules:

- Every tenant-owned table has `organization_id`, and every query filters on it.
- **Events are immutable.** They're never updated, only inserted, and eventually
  dropped by retention.
- **Delivery state lives on `deliveries`**, and **history lives on
  `delivery_attempts`**. The table shows what's true now; the log shows how it got
  there.
- Use `(organization_id, idempotency_key)` as a unique constraint to enforce
  idempotency in the database, not in application code where it could race.
- IDs are UUIDs (v7, which are time-ordered, so indexes stay efficient).

---

## 8. Guarantees we promise (non-functional requirements)

We write these down because they define what "correct" means. Each one gets tests.

1. **An accepted event is never lost.** Once we return `202`, the event and its
   processing job are committed.
2. **At-least-once delivery.** A webhook may occasionally be sent twice (for example,
   if the worker crashes after sending but before recording). It is never silently
   dropped. Receivers deduplicate using the delivery ID we send. *Exactly-once
   delivery over a network is impossible, and being able to explain why is a strong
   interview answer.*
3. **Idempotent ingestion.** The same idempotency key within an org returns the
   original result and never creates a second event.
4. **Tenant isolation.** No API or dashboard path can read or change another org's
   data. Automated tests try to.
5. **Fast ingestion.** Target p99 under 50 ms for `POST /v1/events` at our load-test
   rate (the rate will be set in flow 11).
6. **Clean shutdown.** `SIGTERM` stops accepting new work, finishes in-flight requests
   and jobs within a deadline, and releases unfinished jobs back to the queue.
7. **Observable.** Every request and job can be traced by ID across logs and traces.

---

## 9. Tech stack

| Choice | Why |
|---|---|
| **Node.js 24+ and TypeScript** | Your strongest language, and the ecosystem you're hiring into. Node now runs `.ts` files directly (type stripping), so no build step is needed in development. `tsc` is used only for type checking. |
| **`node:http`** | Deliberately no framework (see section 6). |
| **PostgreSQL 17 + `pg` driver, raw SQL** | Writing SQL yourself is the backend skill. ORMs hide the parts interviews ask about. A thin helper layer only. |
| **Plain `.sql` migration files + a small runner** | You can see exactly what runs, and the runner teaches you how migration tools work. |
| **Zod** | Validation for request bodies and config. We don't write our own validation library. |
| **Argon2** | Password hashing. Never write your own cryptography. |
| **Pino** | Fast structured JSON logging. |
| **`node:test`** | Built-in test runner; no Jest configuration to maintain. |
| **Docker Compose** | Postgres locally now; Redis, Grafana, and the OTel collector later. |
| **Redis** (flow 11+) | Rate limiting. Possibly BullMQ in flow 13. |
| **OpenTelemetry** (flow 9) | Vendor-neutral traces and metrics. |
| **k6** (flow 11) | Load testing. |
| **Minimal dashboard** | Server-rendered HTML or a tiny SPA. Low priority. The API is the product. |

---

## 10. Out of scope (non-goals)

Saying "no" keeps the project finishable:

- Email/SMS/Slack integrations (the webhook is the one destination type; everything else is "just another webhook")
- A complex rule language (simple AND-ed field conditions only)
- Billing, SSO/OAuth login, email verification, password reset flows (maybe later)
- A polished UI
- Kubernetes (Docker Compose plus one simple deploy target is enough)
- Microservices (two processes from one codebase is the right size)

---

## 11. How we work

- **One flow at a time.** Each flow is something a client or user can actually do,
  end to end, and ends in a working, tested, committed state. Infrastructure is added
  only when the current flow needs it. See `docs/02-roadmap.md`.
- **Decision records** in `docs/decisions/NNNN-title.md` for every non-obvious choice:
  the context, the options considered, the decision, and its consequences. These
  become interview material and blog posts.
- **Tests in each flow:** unit tests for pure logic (rule evaluation, backoff),
  integration tests against a real Postgres (no DB mocks for queries), and failure
  tests (kill the worker, duplicate requests).
- **README stays current:** what it is, an architecture diagram, how to run it, and
  known limitations.
- **Definition of done for a flow:** the features work, the tests pass, the docs and
  decision records are updated, and there's something you can demo.
