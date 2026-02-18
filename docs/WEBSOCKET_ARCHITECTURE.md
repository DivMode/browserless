# WebSocket Architecture: Browserless Session Topology

## 1. Connection Topology

```
pydoll-scraper (Python)
  |
  |  WebSocket #1: CDPProxy (browser-level)
  |  ws://browserless:3000 -> ws://127.0.0.1:{port}/devtools/browser/{id}
  |  Purpose: All CDP commands + events (Target.*, Page.*, Runtime.addBinding)
  |
  +---> browserless (Node.js)
        |
        |  WebSocket #2: Replay Coordinator (browser-level)
        |  ws://127.0.0.1:{port}/devtools/browser/{id}
        |  Purpose: rrweb injection, event collection, CF solver, iframe tracking
        |
        |  WebSocket #3..N: Per-Page WS (one per tab)
        |  ws://127.0.0.1:{port}/devtools/page/{targetId}
        |  Purpose: Runtime.evaluate only (zero-contention polling)
        |
        +---> Chrome (Chromium browser)
              +-- 5 concurrent tabs (pages)
```

**Total WS connections per session:** 2 (browser-level) + up to 5 (per-page) = **7 max**

### Connection Ownership

| Connection | Owner | Endpoint | Lifetime |
|---|---|---|---|
| CDPProxy WS | pydoll-scraper | `/devtools/browser/{id}` | Full session |
| Replay Coordinator WS | browserless | `/devtools/browser/{id}` | Full session |
| Per-Page WS (x5) | browserless | `/devtools/page/{targetId}` | Per tab |

## 2. Why Per-Page WebSockets Exist

With `MAX_CONCURRENT_TABS = 5`:
- 5 tabs x 500ms polling = **10 `Runtime.evaluate` calls/sec** for rrweb event collection alone
- Cloudflare solver adds its own polling per tab
- pydoll sends its own CDP commands (navigation, DOM queries, form fills)

**Without per-page WS:** All 10+ evaluates/sec compete with pydoll's commands on a single browser-level WebSocket. Chrome CDP processes messages sequentially per connection — a slow `Runtime.evaluate` blocks pydoll's `Page.navigate` behind it.

**With per-page WS:** Each tab has a dedicated WebSocket routed directly to that page's V8 isolate. Zero contention between tabs, zero contention with pydoll.

### Scaling Impact

| Tabs | Evaluates/sec | Single WS Contention | Per-Page WS Contention |
|---|---|---|---|
| 5 | 10 | Moderate | None |
| 15 | 30 | Severe | None |
| 30 | 60 | Unusable | None |

Per-page WS is essential for scaling beyond 5 concurrent tabs.

## 3. Command Routing Rules

```
sendCommand(method, params, cdpSessionId, timeoutMs, forceMainWs)
  |
  |-- forceMainWs === true?
  |     YES --> browser-level WS (bypass per-page WS entirely)
  |
  |-- method === 'Runtime.evaluate' AND per-page WS exists and OPEN?
  |     YES --> per-page WS (no sessionId needed, WS is page-scoped)
  |     NO  --> browser-level WS (with sessionId for target routing)
  |
  +-- All other methods --> browser-level WS (always)
```

### `forceMainWs` — Critical Operations

Some `Runtime.evaluate` calls MUST go through the browser-level WS even when a per-page WS exists:

| Caller | Why forceMainWs |
|---|---|
| `collectEvents` (rrweb) | Atomic read-and-clear — losing the response means events are gone forever |
| Self-healing check | Verifies rrweb injection state after collection |
| Re-injection | Restores rrweb recording if self-healing detects it's missing |

CF solver polling stays on per-page WS — it's fire-and-forget with `.catch(() => {})`, so losing one poll result is acceptable (it retries). Event collection is NOT acceptable to lose.

### Why Only `Runtime.evaluate`?

Per-page WebSocket connections (`/devtools/page/{targetId}`) have a critical limitation: **they only deliver responses (messages with an `id` field), not events (messages without `id`)**.

| Command Type | Per-Page WS | Browser WS | Why |
|---|---|---|---|
| `Runtime.evaluate` | Yes | Fallback | Stateless, response-only |
| `Runtime.addBinding` | **No** | Yes | `bindingCalled` events only arrive on browser WS |
| `Page.addScriptToEvaluateOnNewDocument` | **No** | Yes | Setup command, events on browser WS |
| `Target.setAutoAttach` | **No** | Yes | `attachedToTarget` events on browser WS |

## 4. The Bug We Fixed (Turnstile Routing)

### Symptom
Cloudflare Turnstile auto-solve stopped working. Scrapes completed but CF challenges timed out — the solver never detected that Turnstile had been solved.

### Root Cause
When per-page WS was first introduced, **all** CDP commands for a page were routed through it (not just `Runtime.evaluate`). This included `Runtime.addBinding`, which registers a JS binding that fires `Runtime.bindingCalled` events when invoked.

The problem: `Runtime.addBinding` was sent on the per-page WS, but `Runtime.bindingCalled` events only arrive on the **browser-level** WS. The per-page WS silently drops all events (they have no `id` field, so the message handler ignores them).

Result: The CF solver registered its `__turnstileSolvedBinding` on the per-page WS. When Turnstile solved and called the binding, the `bindingCalled` event arrived on the browser WS where nobody was listening for it. The solver timed out waiting for a signal that was silently discarded.

### Fix
One-line restriction: per-page WS is now used **only** for `Runtime.evaluate`. All other commands (including `Runtime.addBinding`) go through the browser-level WS where their events are properly handled.

## 5. The Stuck Session Issue

### Symptom
After ~10 minutes of successful operation (20/20 scrapes with working Turnstile), the entire Chrome session became unresponsive. All `Runtime.evaluate` commands timed out at 30s. Zero domains completed.

### Root Cause
Per-page WebSocket connections had **no keepalive mechanism** (no ping/pong). When Chrome experienced memory pressure or GC pauses, per-page WS connections would silently stop responding — the TCP connection appeared alive but Chrome's CDP handler was no longer processing messages.

The cascade:
1. Per-page WS stops responding (no pong detection, appears healthy)
2. `sendCommand('Runtime.evaluate')` routes through the dead WS
3. 30s timeout fires, but rrweb polling sends new commands every 500ms per tab
4. With 5 tabs: 10 dead commands/sec, each waiting 30s = 300 pending timeouts
5. New commands keep queueing → session fully saturated

### Prevention (Implemented)
1. **Ping/pong keepalive:** Per-page WS pings every 10s. If no pong within 5s, the WS is hard-terminated.
2. **Auto-reconnect:** When `sendCommand` finds a dead per-page WS, it deletes it, triggers async reconnection, and falls back to browser-level WS for that command.
3. **Health logging:** Every 30s, logs the count of healthy vs total per-page WS connections for monitoring.
4. **Session-level safeguards (pydoll):** 5-minute overall scrape timeout ensures stuck scrapes always release their semaphore slot. Consecutive CDP health failures trigger session destruction.

## 6. The 0-Event Replay Bug (collectEvents via Per-Page WS)

### Symptom
Successful scrapes showed `replay_event_count=0`. Replays existed but contained no events — diagnostic backbone completely broken.

### Root Cause
`collectEvents` uses `Runtime.evaluate` with JS that atomically **reads AND clears** the event buffer:
```js
(() => { const e = window.__browserlessRecording?.events?.splice(0) || []; return JSON.stringify(e); })()
```

This was routed through the per-page WS. If the per-page WS closed between Chrome executing the expression and delivering the response:
1. Events are cleared from the buffer (JS executed successfully inside Chrome)
2. Response containing the events is lost (WS closed, pending command rejected)
3. `catch {}` in collectEvents swallows the error silently
4. Events are gone forever — not in the buffer (cleared), not collected (response lost)

This only affected degraded sessions where per-page WS connections were dying (ping timeout, memory pressure).

### Fix
Added `forceMainWs` parameter to `sendCommand`. All `collectEvents` calls use `forceMainWs: true` to bypass per-page WS and route through the stable browser-level WS. See Section 3 for routing rules.

CF solver polling intentionally stays on per-page WS — losing one fire-and-forget poll is harmless.
