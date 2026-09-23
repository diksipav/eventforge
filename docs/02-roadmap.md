# OpsWatch: Roadmap (flow by flow)

> **The rule of this roadmap:** we build one **flow** at a time, meaning one thing a
> user or client can actually do, end to end. We add a piece of infrastructure
> (config, logging, a database, shutdown handling, timeouts...) **only when the
> current flow runs into the problem it solves.** If you can't say what problem a
> line of code solves *right now*, it doesn't go in yet.
>
> Each flow ends in a working state: you can demo it with `curl`, it has tests, and
> it's committed. Later flows are intentionally rougher and will be refined when we
> get there.

How each step is described:

- **Problem**: what doesn't work yet, or what breaks
- **Build**: the smallest thing that solves it
- **Done when**: how you check it
- **You learn**: the concept behind it

---

## Overview

| # | Flow | What becomes possible | New pieces introduced |
|---|---|---|---|
| 0 | A server that answers | `curl /healthz` works | `node:http`, request/response basics |
| 1 | Accept an event | `POST /v1/events`, `GET /v1/events/:id` (in memory) | Body parsing, validation, router, error format, tests |
| 2 | Events survive a restart | Events are stored in Postgres | Docker Compose, config, migrations, DB pool, logging, async shutdown |
| 3 | Know who is sending | Only clients with an API key can send; they see only their own events | Orgs, hashed API keys, tenant scoping |
| 4 | Retrying is safe | Sending the same request twice creates one event | Idempotency keys, unique constraints, races |
| 5 | Process events in the background | A worker picks up every new event | Jobs table, `SKIP LOCKED`, second process, leases |
| 6 | Notify when a rule matches | Matching events trigger a webhook | Rules, destinations, deliveries, outgoing HTTP |
| 7 | Deliveries survive failure | Failed webhooks are retried, then marked dead, and can be replayed | Backoff + jitter, attempt history |
| 8 | Webhooks are safe | Signed payloads, no SSRF, one bad endpoint can't hurt the rest | HMAC, IP filtering, circuit breaker |
| 9 | See what happened | Follow one event across API → DB → worker → webhook | OpenTelemetry, metrics, Grafana |
| 10 | Humans can log in | Sign up, log in, manage keys and rules | Passwords, sessions, cookies, CSRF |
| 11 | Handle load and abuse | Real performance numbers; noisy clients get `429` | Redis rate limiting, k6, partitioning |
| 12 | Ship it | A public URL, CI, and deploys without dropped requests | Dockerfile, CI, deploy, shutdown behind a load balancer |
| 13 | *(optional)* Outbox + BullMQ | Redis-based queue without losing atomicity | Outbox pattern, dual-write problem |
| 14 | *(optional)* Dashboard UI | A small UI on top of the API | — |

---

## Flow 0: A server that answers ✅

**Build:** A `node:http` server responding to `GET /healthz` with `200 {"status":"ok"}`
and anything else with `404` JSON. Ctrl+C stops it.

---

## Flow 1: Accept an event

The core of the product: a client sends an event and gets an ID back. Events live in
memory for now, since a database isn't needed to get this flow right.

### 1.1 Read a JSON body
- **Problem:** `req` is a stream, so the body doesn't just appear as an object.
- **Build:** `POST /v1/events` reads the body chunk by chunk, joins the chunks, and
  parses the JSON. For now it just returns what it received.
- **Then break it on purpose, and handle each case:**
  - Invalid JSON → `400`
  - Missing or wrong `Content-Type` → `415`
  - A 10 MB body → `413`. Stop reading once you pass a limit such as 64 KB. Don't
    buffer everything first and check afterwards.
  - A client that sends the body extremely slowly → this is where **`server.requestTimeout`**
    and **`server.headersTimeout`** come in. Try it with a small script, then set them.
- **Done when:** Each of the cases above returns the right status code.
- **You learn:** Streams, why size limits exist (memory exhaustion), slow-client attacks.

### 1.2 Validate the event
- **Problem:** `{"foo": 1}` is valid JSON but not a valid event.
- **Build:** A Zod schema for an event: `type`, `source`, `severity`
  (`info`/`warning`/`critical`), optional `occurredAt`, and `payload`. Invalid input
  → `400` with details about which field is wrong.
- **Decide on one error format** now, because this is the first time you have several
  kinds of errors. For example:
  `{ "error": { "code": "validation_failed", "message": "...", "details": [...] } }`
- **Done when:** Valid events → `202 { id }`, invalid events → `400` in that format.
- **You learn:** Never trusting input, and designing API errors for the people who
  call your API.

### 1.3 Store and fetch events, and introduce the router
- **Problem:** You need `GET /v1/events/:id`, which has a path *parameter*. `if (req.url === ...)`
  can't handle that, and `server.ts` is turning into a long list of `if`s.
- **Build:**
  - Keep events in an in-memory `Map` and generate IDs with `crypto.randomUUID()`.
  - `GET /v1/events/:id` → `200` or `404`. `GET /v1/events` → a list.
  - **Now extract a small router** (`src/http/router.ts`): register method + path
    pattern, match the request, extract params. Known path with the wrong method → `405`.
  - Move the body/JSON helpers into `src/http/`.
  - A single error handler: known errors → 4xx, unknown errors → `500` with a
    generic message.
- **Done when:** You can create an event with curl, then fetch it by ID. `server.ts`
  is short again.
- **You learn:** What a router and middleware actually are. You now understand
  Express from the inside.

### 1.4 First tests
- **Problem:** Every change so far meant re-running curl commands by hand.
- **Build:** `node:test` tests:
  - Unit tests: router matching and validation.
  - An integration test that starts the server on port `0` (a random free port) and
    calls it with `fetch`: create an event, fetch it, 404, 405, 413, 415, invalid JSON.
  - To make that work, split *creating* the server (`src/app.ts`, which exports a
    function) from *starting* it (`src/server.ts`). This is the first real reason for
    `app.ts` to exist.
- **Done when:** `npm test` passes without anything else running.
- **You learn:** Testing HTTP without mocks, and why "build the app" and "run the
  app" are separate.

---

## Flow 2: Events survive a restart

- **Problem:** Restart the server and every event is gone.

### 2.1 Run Postgres locally
- **Build:** `docker-compose.yml` with Postgres 17 (named volume, healthcheck).
  Connect with `psql` and look around.
- **You learn:** Why the database lives in a container and the app doesn't (yet).

### 2.2 Configuration
- **Problem:** The app now needs `DATABASE_URL`, and a password must not be in the code.
- **Build:** `src/config.ts` validates `process.env` with Zod, fails at startup with a
  clear message, and exports one typed object. `PORT` and `HOST` move there too.
  Load `.env` with `node --env-file`.
- **Done when:** A missing `DATABASE_URL` → a clear error and exit code 1.
- **You learn:** Failing fast, and the idea that config comes from the environment.

### 2.3 Schema and migrations
- **Problem:** The `events` table has to be created the same way on every machine.
- **Build:** `migrations/0001_create_events.sql` plus a small runner script
  (`npm run migrate`). It applies files in order, records them in `schema_migrations`,
  and runs each one in a transaction.
- **You learn:** Why schema changes are versioned. (Advisory locks come later, in flow 12.)

### 2.4 Store events in Postgres
- **Build:** A `pg` pool and an `events` repository (`insert`, `findById`, `list`)
  using parameterized SQL. The route handlers stop using the `Map`.
- **Add cursor pagination** to `GET /v1/events` now, because a real table can be big.
- **Done when:** Create an event, restart the server, and the event is still there.
- **You learn:** Connection pools, SQL injection and parameters, cursor vs offset
  pagination.

### 2.5 When the database is down
- **Problem:** Stop Postgres and send a request. What does the client see? What do
  *you* see?
- **Build:**
  - The `500` handler logs the real error and never sends it to the client.
  - Switch from `console` to **Pino**, with a **request ID** on every log line (accept
    `X-Request-Id` or generate one, and echo it in the response). Now you can find the
    log for a specific failed request.
  - Add **`GET /readyz`**: can we reach the DB? → `200` or `503`.
  - Add **`unhandledRejection` / `uncaughtException`** handlers. Now that there's async
    DB code everywhere, you'll see why they matter.
- **You learn:** Structured logging, liveness vs readiness, not leaking internals.

### 2.6 Shutdown now has work to do
- **Problem:** On Ctrl+C, the DB pool should be closed cleanly, after in-flight
  requests finish.
- **Build:** Make shutdown async: stop the server → wait for requests → `await pool.end()`
  → exit. Keep the deadline timer.
- **Done when:** A slow request started just before Ctrl+C still completes, and the
  process then exits with code 0.
- **Tests:** Integration tests now run against a separate test database.

---

## Flow 3: Know who is sending

- **Problem:** Anyone can send events, and everyone can see everyone's events.

- **Build:**
  - Migrations: `organizations` and `api_keys`, plus `organization_id` on `events`
  - A CLI script `npm run create-key -- --org "Acme"` creates an org and prints a key
    **once** (`ow_live_...`). It stores only a hash, plus a short prefix so the key
    can be identified. There's no signup yet; humans come in flow 10.
  - An auth step before `/v1/*` routes: read `Authorization: Bearer ...`, hash the key,
    look it up → `401` if missing or wrong. The request gets `{ orgId }`.
  - Every event query takes `orgId`. The repository makes it impossible to forget.
  - Key revocation (a CLI command) and `last_used_at`.
- **Done when:** Tests prove that org A's key gets `404` for org B's event ID, and
  that a revoked key gets `401` immediately.
- **You learn:** Machine authentication, why secrets are hashed, multi-tenancy, why
  you return `404` instead of `403` for other tenants' data.

---

## Flow 4: Retrying is safe

- **Problem:** A client's request times out on their side, so they retry. Did the
  first request succeed? Now there are two events.

- **Build:**
  - Accept an `Idempotency-Key` header. Add a unique constraint on
    `(organization_id, idempotency_key)`.
  - Same key + same body → return the original `202` and ID. Same key + a different
    body → `422`.
  - Fire 20 identical requests **at the same time** in a test. There must be exactly
    one event. You'll find out why "check whether it exists, then insert" is a race
    condition, and why the database constraint is what really protects you.
- **You learn:** Idempotency, race conditions, relying on database constraints.

---

## Flow 5: Process events in the background

- **Problem:** Each event has to be processed (checked against rules, possibly
  triggering notifications), but that can be slow and must not slow down `POST /v1/events`.

- **Build:**
  - Migration: a `jobs` table (type, payload, status, run_at, attempts, locked_until)
  - **In the same transaction** as the event insert, insert a `process_event` job.
    Write down why doing both in one transaction matters (decision record 0002).
  - A new process, `src/worker.ts` (`npm run worker`): loop → claim a job with
    `FOR UPDATE SKIP LOCKED` → for now it only logs "processed event X" → mark it done.
  - Run two workers and confirm no job is processed twice.
  - Kill a worker mid-job (`kill -9`) → the lease (`locked_until`) expires → another
    worker picks the job up.
  - Graceful shutdown for the worker: stop claiming, finish the current job, exit.
  - Event status visible in the API: `pending` / `processed`.
- **You learn:** Queues, concurrency, crash recovery, why the API and the worker are
  separate processes.

---

## Flow 6: Notify when a rule matches

- **Problem:** Processing events doesn't do anything useful yet.

- **Build:**
  - Migrations: `destinations` (webhook URL), `rules` (conditions + destination),
    `deliveries`
  - API (with API key auth): create, list, and delete destinations and rules
  - **Rule evaluation as a pure function**: given conditions and an event, return
    true/false. AND-ed conditions, operators `eq`, `neq`, `in`, `contains`. Unit-test it heavily.
  - `process_event` → evaluate the rules → create a delivery + a `deliver` job for each match
  - `deliver` → `fetch` the webhook with a **timeout**, mark it succeeded or failed
  - A small **mock receiver** script (a second tiny server) that prints what it receives
- **Done when:** You create a rule, send a matching event, and the mock receiver prints it.
- **You learn:** Outgoing HTTP, timeouts on calls you make, keeping business logic in
  pure functions.

---

## Flow 7: Deliveries survive failure

- **Problem:** Make the mock receiver fail half the time. Deliveries are lost.

- **Build:**
  - `delivery_attempts` table: status code, latency, error, truncated response
  - Classify results: 2xx success; 5xx, timeout, or network error → retry; most 4xx →
    give up; 429 → respect `Retry-After`
  - Exponential backoff **with jitter**, a maximum number of attempts → `dead`
  - API: list deliveries and their attempts; `POST /v1/deliveries/:id/replay`
- **Done when:** Against a flaky receiver, every delivery ends up `succeeded` or `dead`
  with its full history.
- **You learn:** At-least-once delivery, why exactly-once is impossible, backoff, and
  the thundering herd problem.

---

## Flow 8: Webhooks are safe

- **Problem 1:** Receivers can't tell whether a request really came from OpsWatch.
  → **HMAC-SHA256 signature** over the timestamp and body, a signing secret for each
  destination, and a verification example in the mock receiver.
- **Problem 2:** A client can create a destination like `http://169.254.169.254/...`
  or `http://localhost:5432`, making our worker attack our own network.
  → **SSRF guard**: resolve DNS, block private, loopback, and link-local IPs, and check
  again at request time.
- **Problem 3:** One destination that always times out ties up the worker.
  → **Circuit breaker** for each destination.
- **You learn:** Webhook security, SSRF, isolating failures.

---

## Flow 9: See what happened

- **Problem:** "Why was this alert 30 seconds late?" You can't answer that with logs
  alone, across two processes.
- **Build:** OpenTelemetry in the API and the worker. Store `traceparent` on the job
  so worker spans connect to the original request. Metrics: request latency, queue
  depth, job lag, delivery success rate. Grafana in Docker Compose (for example
  `grafana/otel-lgtm`).
- **Done when:** A single trace shows HTTP request → insert → worker → webhook call.
- **You learn:** Distributed tracing, which metrics matter for a queue-based system.

---

## Flow 10: Humans can log in

- **Problem:** Creating keys and rules requires the CLI or an API key. Real users need
  accounts.
- **Build:** `users`, `memberships`, `sessions`. Sign up and log in with Argon2, a
  session cookie (`HttpOnly`, `Secure`, `SameSite`), logout, CSRF protection.
  Dashboard endpoints to manage API keys, destinations, and rules. An audit log.
- **You learn:** Sessions vs JWTs, password storage, cookie security, CSRF, two auth
  models in one app.

---

## Flow 11: Handle load and abuse

- **Problem:** How many events per second can this take? What if one client sends a
  million?
- **Build:**
  - **k6 load test** of `POST /v1/events`: record p50/p95/p99, find the first
    bottleneck, fix it, and write down before and after.
  - **Redis rate limiting** per API key → `429` with `Retry-After`.
  - **Partition `events` by month** + a retention job; clean up finished jobs; use
    `EXPLAIN ANALYZE` on the main queries.
- **You learn:** Measuring before optimizing, distributed rate limiting, keeping large
  tables fast.

---

## Flow 12: Ship it

- **Problem:** It only runs on your laptop.
- **Build:**
  - Multi-stage Dockerfile running as a non-root user; the whole stack in Compose
  - GitHub Actions: typecheck, lint, and tests against a Postgres service container
    (you can add this earlier, any time after flow 1.4)
  - Deploy to Fly.io, Railway, or a VPS, running migrations as a release step
    (**now** add an advisory lock to the migration runner, because two instances may
    start at the same time)
  - **Shutdown behind a load balancer:** `/healthz` returns `503` while shutting down,
    responses send `Connection: close`, and the server listens on `0.0.0.0`
- **Done when:** A public URL, green CI, and a deploy during a k6 run drops no requests.
- **You learn:** Containers, CI, zero-downtime deploys.

---

## Optional: Flow 13 (outbox + BullMQ) and Flow 14 (dashboard UI)

- **13:** Move the job transport to Redis/BullMQ. To keep the "event + job are saved
  together" guarantee, use an `outbox` table and a dispatcher. Compare performance
  with flow 11 and write a decision record on when the switch is worth it.
- **14:** A small UI: events list, event detail with deliveries and attempts, a
  replay button, key management.

## Ideas for later

- Heartbeat rules ("no event from service X in 10 minutes → alert")
- Alert grouping ("the same alert 50× in 5 minutes → one notification")
- GitHub/Stripe webhooks as event sources
