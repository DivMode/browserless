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

## 3. Command Routing Rules (Updated 2026-02-19)

```
sendCommand(method, params, cdpSessionId, timeoutMs)
  |
  |-- method is PAGE_WS_SAFE? (Runtime.evaluate OR Page.addScriptToEvaluateOnNewDocument)
  |     YES --> per-page WS if exists and OPEN, else browser-level WS
  |     NO  --> browser-level WS (always)
```

`PAGE_WS_SAFE` is defined inline in `replay-session.ts`:
```typescript
const PAGE_WS_SAFE = method === 'Runtime.evaluate' || method === 'Page.addScriptToEvaluateOnNewDocument';
```

### Why These Two Commands?

Both `Runtime.evaluate` and `Page.addScriptToEvaluateOnNewDocument` are stateless request-response commands — they don't generate CDP events that need to be received on the browser-level WS. Per-page WS connections only deliver command responses (messages with an `id` field), not events.

| Command Type | Per-Page WS | Browser WS | Why |
|---|---|---|---|
| `Runtime.evaluate` | Yes | Fallback | Stateless, response-only |
| `Page.addScriptToEvaluateOnNewDocument` | Yes | Fallback | Stateless, response-only |
| `Runtime.addBinding` | **No** | Yes | `bindingCalled` events only arrive on browser WS |
| `Target.setAutoAttach` | **No** | Yes | `attachedToTarget` events on browser WS |
| `Input.*` (mouse/keyboard) | **No** | Yes | Must go through browser WS |

> **Note:** The previous `forceMainWs` parameter has been removed. The `PAGE_WS_SAFE` set is the sole routing decision. rrweb event collection now uses push-based `Runtime.addBinding('__rrwebPush')` instead of polling, so the old concern about atomic read-and-clear via `collectEvents` through per-page WS no longer applies. The 5s fallback poll still goes through per-page WS (acceptable — it's non-atomic and idempotent).

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

### Prevention (Updated 2026-02-19)
1. **Per-page WS keepalive (non-destructive):** Ping every 30s. If no pong within 30s, the WS is terminated. Logged at debug level. A dead per-page WS is NOT fatal — `sendCommand` transparently falls back to browser-level WS. No cascade.
2. **No main WS ping/pong:** The main browser-level WS has NO keepalive. Chrome process death fires WS `close` event naturally via TCP. SessionLifecycleManager handles zombie sessions via TTL. The previous 5s main WS ping/pong was the root cause of the replay URL disappearance bug (Chrome missed one pong under load → WS terminated → permanent replay death).
3. **TargetRegistry atomic cleanup:** When per-page WS dies, `target.pageWebSocket = null` is set atomically. `sendCommand` checks this and falls back to browser WS. No stale references.
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
