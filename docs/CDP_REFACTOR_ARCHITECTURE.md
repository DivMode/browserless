# CDP Event Architecture Refactor

> **Status:** Proposal
> **Date:** 2026-02-17
> **Problem:** CDP events are unreliable — Cloudflare solver events not reaching clients, data not flowing, commands timing out under tab contention.

---

## Table of Contents

1. [Root Cause](#root-cause)
2. [Failure Points](#failure-points)
3. [Ecosystem Survey](#ecosystem-survey)
4. [Proposed Architecture](#proposed-architecture)
5. [Implementation Details](#implementation-details)
6. [Implementation Priority](#implementation-priority)

---

## Root Cause

The system relies on CDP events for correctness, but **CDP provides zero delivery guarantees.** CDP was designed as a debugging protocol — events are fire-and-forget. No buffering, no replay, no acknowledgment.

When 15+ tabs share a single browser-level WebSocket, events queue behind each other, `Runtime.evaluate` calls take ~8 seconds each, and the entire pipeline stalls. The Cloudflare solver depends on a chain of CDP events (`Target.attachedToTarget` → `Runtime.bindingCalled` → `Runtime.evaluate` polling), and any break in that chain means the solve never completes or the client never hears about it.

### The Three WebSocket Layers

```
┌──────────────┐       ┌───────────────┐       ┌──────────────────┐
│  Client      │◄─────►│  CDPProxy     │◄─────►│  Chrome Browser  │
│  (Pydoll)    │  WS   │  (intercept)  │  WS   │  /devtools/      │
└──────────────┘       └───────────────┘       │  browser/{id}    │
                                                └──────────────────┘
                       ┌───────────────┐              ▲
                       │  Replay       │──────────────┘
                       │  Coordinator  │  separate WS (browser-level)
                       │               │
                       │  ┌──────────┐ │       ┌──────────────────┐
                       │  │ CF Solver│ │       │  Chrome Tab      │
                       │  └──────────┘ │◄─────►│  /devtools/      │
                       └───────────────┘  WS   │  page/{targetId} │
                         (per-page WS,         └──────────────────┘
                          new/uncommitted)
```

**Layer 1: Client ↔ CDPProxy** — Client connects via WebSocket. CDPProxy sits between client and Chrome, forwarding messages bidirectionally. Intercepts custom commands (`Browserless.enableCloudflareSolver`) and injects custom events (`Browserless.cloudflareSolved`).

**Layer 2: ReplayCoordinator ↔ Chrome (browser-level WS)** — Separate raw WebSocket to Chrome's CDP endpoint. Uses `Target.setAutoAttach` with `flatten=true` and `waitForDebuggerOnStart=true`. Handles rrweb injection, event collection, screencast, and Cloudflare solver coordination.

**Layer 3: Per-page WebSockets** (new, uncommitted) — Each tab gets its own WS to `/devtools/page/{targetId}`. Eliminates head-of-line blocking from 15+ tabs sharing one browser WS. CF solver commands route through per-page WS when available.

---

## Failure Points

### Critical — Events Actively Being Dropped

#### 1. CDPProxy Connection Gap

**Location:** `browsers.cdp.ts:425-456` vs `browser-launcher.ts:226-248`

Between `setupReplayForAllTabs()` completing and `proxyWebSocket()` wiring up `emitClientEvent`, the solver's `emitClientEvent` is a no-op (the default empty async function at `cloudflare-solver.ts:195`). Any Cloudflare detection during this window is emitted into the void — the client never receives it.

```
Timeline:
  setupReplayForAllTabs() completes ─── CF detected here = LOST ───► proxyWebSocket() wires emitClientEvent
                                        (emitClientEvent is no-op)
```

#### 2. Per-Page WebSocket Events Not Routed

**Location:** `replay-coordinator.ts:174-185` (per-page WS message handler)

The new per-page WS (`openPageWebSocket`) only handles command-response correlation. It does **not** forward CDP events to the main `ws.on('message')` handler. If Chrome delivers a `Runtime.bindingCalled` event on a page WS instead of the browser WS, it is silently dropped.

The current per-page WS message handler:
```typescript
pageWs.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString());
  // Only resolves pending commands:
  const pending = pendingPageCommands.get(msg.id);
  if (pending) { pending.resolve(msg.result); }
  // CDP events (no msg.id) are IGNORED
});
```

#### 3. Iframe-to-Parent Mapping Uses `.pop()`

**Location:** `replay-coordinator.ts:762`

With multiple concurrent tabs, the fallback `[...targetSessions.values()].pop()` picks the last-registered page session, not the correct parent. This causes:
- CF iframe events injected into the wrong tab's recording
- CF solver tracking the wrong page's detection
- Incorrect `iframeSessions` mapping (iframe→wrong_page instead of iframe→correct_page)

```typescript
// DANGEROUS: picks arbitrary page with multiple tabs
const parentCdpSid = msg.sessionId || [...targetSessions.values()].pop();
```

#### 4. `emitClientEvent` Silently Swallows All Errors

**Location:** `cloudflare-solver.ts` (every `emitClientEvent` call)

Every emission uses `.catch(() => {})`. When the client disconnects slightly before the solver emits, the event vanishes without even a log line. This includes critical events like `Browserless.cloudflareSolved`.

### Moderate — Timing and Race Conditions

#### 5. rrweb Re-Injection vs CF Detection Race

**Location:** `replay-coordinator.ts:883` and `cloudflare-solver.ts:303`

After navigation, rrweb re-injects after a 200ms `setTimeout`, and CF detection runs after a 500ms delay. Recording markers injected by the solver before rrweb re-injection are lost because the rrweb recording object doesn't exist yet.

```
Navigation detected
  +200ms: rrweb re-injected (recording starts)
  +500ms: CF detection runs, injects markers

  If CF detected between 0-200ms: markers have no recording target → LOST
```

#### 6. `iframeSessions` Mapping Can Fail Silently

**Location:** `replay-coordinator.ts:764-772`

If `Network.enable` or `Runtime.enable` throws during iframe attachment (e.g., target already closed), the iframe's CDP session ID never enters `iframeSessions`. All subsequent `Runtime.bindingCalled` events from that iframe (including `__turnstileStateBinding`) are filtered out at line 850:

```typescript
if (msg.sessionId && iframeSessions.has(msg.sessionId)) {
  handleIframeCDPEvent(msg);  // Never reached if mapping failed
}
```

#### 7. `handleClose` Races with `replayComplete` Emission

**Location:** `cdp-proxy.ts:336-360` and `session-lifecycle-manager.ts:99-153`

Client disconnect triggers `handleClose()` which nulls `clientWs`. If `SessionLifecycleManager.close()` is concurrently running step 2 (emit `replayComplete`), the event is dropped because `clientWs` is already null.

### Low — Already Fixed in Uncommitted Changes

8. **Activity loop breaking on widget error** — Previously `break` after widget error killed the loop. Now continues polling since widgets may recover.

9. **`pendingIframes` race** — Added `pendingIframes` map to handle iframe attaching before `ActiveDetection` creation.

10. **Activity loop infinite duration** — Added 90-second max cap.

---

## Ecosystem Survey

### No Node.js Library Solves This

Searched every CDP library, wrapper, and automation framework. The result:

| Library | Language | Event Buffering | Session Multiplexing | Reconnection | Stealth |
|---|---|---|---|---|---|
| chrome-remote-interface | Node.js | No | No | No | No |
| Puppeteer CDPSession | Node.js | No | Yes (flatten) | No | Via plugins |
| Playwright | Node.js | No | Yes | No | Via Patchright |
| vscode-cdp | Node.js | No | Yes | No | No |
| simple-cdp | JS/TS | No | Partial | No | No |
| **mafredri/cdp** | **Go** | **Yes** | Yes | No | No |
| **chromedp** | **Go** | **Yes** | Yes | No | No |
| Pydoll | Python | No | Per-tab WS | No | Yes |
| Nodriver/Zendriver | Python | No | Unknown | No | Yes |
| cdp-use | Python | No | Partial | No | No |
| WebDriver BiDi | Standard | Context-scoped | N/A | N/A | N/A |

**Key findings:**

- **Event buffering only exists in Go libraries.** The Go `mafredri/cdp` library provides `rpcc.Stream` — a buffered async iterator that queues events from the moment of creation. Events are never lost between subscription and consumption. No Node.js equivalent exists.

- **WebDriver BiDi is the future but not ready.** Missing: network throttling, performance tracing, screencasting, code coverage, many emulation features. For Chromium, BiDi runs on top of CDP anyway (via `chromium-bidi`). Expert consensus: "CDP is still the gold standard for browser instrumentation."

- **browser-use's "stateless" pattern is the most robust.** Their architecture re-derives state from the browser on every interaction rather than maintaining in-memory state from events. Watchdog services periodically health-check targets. This eliminates the entire class of "missed event" bugs.

- **Pydoll's per-tab WebSocket architecture is sound** — separate WS connections per tab eliminates head-of-line blocking. The uncommitted changes in `replay-coordinator.ts` are moving in this direction.

### Relevant Patterns from Other Libraries

**mafredri/cdp (Go) — Buffered Event Streams:**
```go
// Create event stream BEFORE enabling domain — events buffer from creation
domContent, _ := page.DOMContentEventFired(ctx)
page.Enable(ctx)
// Consume buffered events — nothing lost
event, _ := domContent.Recv()
```

**browser-use — Stateless State Derivation:**
```python
# Don't trust events. Query the browser for current truth.
# Periodic health check: evaluate 1+1 on each target to detect crashes.
# Watchdog services monitor for spontaneous downloads, crashes, etc.
```

**Puppeteer — waitForDebuggerOnStart Pattern:**
```javascript
// Pause new targets until event listeners are ready
await cdp.send('Target.setAutoAttach', {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: true  // Target pauses until Runtime.runIfWaitingForDebugger
});
// Window to register listeners before target executes
```

---

## Proposed Architecture

### Core Shift: Poll-Driven with Event Acceleration

**Current (event-driven):**
```
CDP Event fires → Handler called → State updated → Action taken
     ↓ (if event lost)
  Nothing happens. System is stuck.
```

**Proposed (poll-driven + event-accelerated):**
```
Poll loop (every N ms) → Query browser state → Diff against known state → Act
CDP Event fires → Immediately trigger poll → Faster response
     ↓ (if event lost)
  Next poll cycle catches it anyway. System self-heals.
```

Events become **acceleration hints** — they trigger an immediate poll for faster response, but the system doesn't depend on them for correctness. If an event is dropped, the next scheduled poll catches the state change anyway.

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        ReplayCoordinator                         │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐ │
│  │ CDPConnection │   │ StatePoller  │   │ ClientEventQueue    │ │
│  │              │   │              │   │                     │ │
│  │ • browserWs  │──►│ • poll()     │   │ • queue (pre-conn) │ │
│  │ • pageWsMap  │   │ • diff()     │──►│ • flush on connect │ │
│  │ • subscribe()│   │ • unified JS │   │ • emit()           │ │
│  │ • send()     │   └──────────────┘   └─────────────────────┘ │
│  │ • buffered   │          │                     │              │
│  │   events     │          ▼                     ▼              │
│  └──────────────┘   ┌──────────────┐   ┌─────────────────────┐ │
│         │           │ CF Solver    │   │ CDPProxy            │ │
│         │           │              │   │ (client WS)         │ │
│         ▼           │ • stateless  │   └─────────────────────┘ │
│  ┌──────────────┐   │ • poll-based │                            │
│  │ Event Router │──►│ • event-     │                            │
│  │ (all WS msgs)│   │   accelerated│                            │
│  └──────────────┘   └──────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. `CDPConnection` — Unified WebSocket Manager

Replaces the current raw WebSocket handling scattered across `replay-coordinator.ts`. Manages both browser-level and per-page WebSockets, provides buffered event subscription, and rejects all pending commands on disconnect.

```typescript
class CDPConnection {
  private browserWs: WebSocket;
  private pageWsMap = new Map<string, WebSocket>();  // targetId → per-page WS
  private pendingCommands = new Map<number, { resolve, reject, timer }>();
  private eventSubscribers = new Map<string, Set<EventCallback>>();
  private eventBuffers = new Map<string, CDPEvent[]>();  // buffered until consumed
  private msgId = 0;

  /**
   * Buffered event subscription inspired by mafredri/cdp.
   * Events are queued from the moment of subscription until consumed.
   * Nothing is lost between subscribe() and the first read.
   */
  subscribe(method: string, filter?: { sessionId?: string }): AsyncIterable<CDPEvent> {
    // Returns async iterator. Events buffer until consumed via for-await.
    // Prevents the "event fires before listener registered" class of bugs.
  }

  /**
   * Send a CDP command with automatic WebSocket routing.
   * Uses per-page WS if available and open; falls back to browser WS.
   * Rejects after timeout (default 30s). Never hangs.
   */
  async send(method: string, params?: object, opts?: {
    sessionId?: string;
    targetId?: string;
    timeout?: number;
  }): Promise<any> {
    const ws = this.selectWebSocket(opts?.targetId);
    const id = ++this.msgId;
    const payload: any = { id, method, params };
    if (opts?.sessionId) payload.sessionId = opts.sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`CDP timeout: ${method} after ${opts?.timeout ?? 30000}ms`));
      }, opts?.timeout ?? 30000);

      this.pendingCommands.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(payload));
    });
  }

  /**
   * Open a per-page WebSocket for reduced contention.
   * CRITICAL FIX: Routes both command responses AND events through
   * the main dispatcher, unlike the current implementation which
   * only handles command responses on per-page WS.
   */
  async attachPageWs(targetId: string): Promise<void> {
    const pageWs = new WebSocket(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    this.pageWsMap.set(targetId, pageWs);

    pageWs.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id) {
        // Command response
        const pending = this.pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(msg.id);
          msg.error ? pending.reject(msg.error) : pending.resolve(msg.result);
        }
      } else {
        // CDP EVENT — route to main dispatcher (THIS IS THE FIX)
        this.dispatchEvent(msg);
      }
    });
  }

  /**
   * On any WebSocket close, reject ALL pending commands.
   * Prevents promises from hanging indefinitely.
   */
  private handleWsClose(ws: WebSocket) {
    const error = new Error('CDP WebSocket closed');
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private selectWebSocket(targetId?: string): WebSocket {
    if (targetId) {
      const pageWs = this.pageWsMap.get(targetId);
      if (pageWs?.readyState === WebSocket.OPEN) return pageWs;
    }
    return this.browserWs;
  }

  private dispatchEvent(msg: CDPMessage) {
    const subscribers = this.eventSubscribers.get(msg.method);
    if (subscribers) {
      for (const cb of subscribers) cb(msg);
    }
    // Also buffer for async iterators
    const buffer = this.eventBuffers.get(msg.method);
    if (buffer) buffer.push(msg);
  }
}
```

### 2. `ClientEventQueue` — Buffer Pre-Connection Events

Fixes the CDPProxy connection gap (Failure Point #1). Events emitted before the client WebSocket is connected are buffered and flushed on connect.

```typescript
class ClientEventQueue {
  private queue: Array<{ method: string; params: object }> = [];
  private clientWs: WebSocket | null = null;
  private log = new Logger('client-event-queue');

  /**
   * Called when CDPProxy finishes connecting the client.
   * Flushes any events that were emitted during the connection gap.
   */
  setClient(ws: WebSocket) {
    this.clientWs = ws;
    if (this.queue.length > 0) {
      this.log.info(`Flushing ${this.queue.length} buffered events to client`);
      for (const event of this.queue) {
        this.send(event);
      }
      this.queue = [];
    }
  }

  /**
   * Emit a custom CDP event to the client.
   * Buffers if client not yet connected. Logs on failure (not silent).
   */
  emit(method: string, params: object) {
    const event = { method, params };
    if (this.clientWs?.readyState === WebSocket.OPEN) {
      this.send(event);
    } else {
      this.log.info(`Buffering event (client not connected): ${method}`);
      this.queue.push(event);
    }
  }

  private send(event: { method: string; params: object }) {
    try {
      this.clientWs!.send(JSON.stringify(event));
    } catch (err) {
      // LOG instead of swallowing silently
      this.log.warn(`Failed to send ${event.method} to client: ${(err as Error).message}`);
    }
  }

  clear() {
    this.queue = [];
    this.clientWs = null;
  }
}
```

### 3. `StatePoller` — Poll-Driven CF Detection

Replaces the chain of 5+ separate `Runtime.evaluate` calls with a single unified evaluation. Under contention, this is the difference between 8 seconds and 40+ seconds per detection cycle.

```typescript
interface PageState {
  url: string;
  hasCfChallenge: boolean;
  cfType: 'managed' | 'turnstile' | 'interstitial' | null;
  cfCtype: string | null;
  cfCray: string | null;
  hasWidget: boolean;
  widgetBounds: DOMRect | null;
  token: string | null;
  solved: boolean;
  hasError: boolean;
  timestamp: number;
}

/**
 * Single-expression state query. One CDP round-trip returns everything
 * the CF solver needs to know about the page.
 */
const UNIFIED_STATE_JS = `(() => {
  const s = {};
  // CF detection (replaces CF_DETECTION_JS)
  const opt = window.cf_chl_opt;
  s.hasCfChallenge = !!(opt || document.getElementById('challenge-running')
    || document.getElementById('challenge-form'));
  s.cfType = opt ? 'managed' : (document.querySelector('.cf-turnstile') ? 'turnstile' : null);
  s.cfCtype = opt?.cType ?? null;
  s.cfCray = opt?.cRay ?? null;

  // Widget state (replaces TURNSTILE_DETECT_AND_AWAIT_JS + FIND_CLICK_TARGET_JS)
  const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  s.hasWidget = !!iframe;
  s.widgetBounds = iframe ? iframe.getBoundingClientRect().toJSON() : null;

  // Token (replaces TURNSTILE_TOKEN_JS)
  const input = document.querySelector('[name="cf-turnstile-response"]');
  s.token = input?.value || null;
  s.solved = !!(s.token && s.token.length > 20);

  // Error state (replaces TURNSTILE_ERROR_CHECK_JS)
  s.hasError = !!(document.querySelector('.cf-error-details')
    || document.querySelector('[class*="error"]'));

  // URL for navigation detection
  s.url = location.href;
  s.timestamp = Date.now();
  return s;
})()`;

class StatePoller {
  private knownState = new Map<string, PageState>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private log = new Logger('state-poller');

  constructor(private cdp: CDPConnection) {}

  /**
   * Start polling a page. Returns an async iterable of state changes.
   * CDP events can call triggerPoll() for immediate check.
   */
  startPolling(targetId: string, cdpSessionId: string, intervalMs = 500): AsyncIterable<StateChange> {
    // Returns async generator that yields diffs
  }

  /**
   * Single poll: evaluate unified JS, diff against known state, return changes.
   */
  async poll(targetId: string, cdpSessionId: string): Promise<StateChange[]> {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: UNIFIED_STATE_JS,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, { sessionId: cdpSessionId, targetId, timeout: 5000 });

    const newState: PageState = result.result?.value;
    if (!newState) return [];

    const oldState = this.knownState.get(targetId);
    this.knownState.set(targetId, newState);

    if (!oldState) {
      // First poll — report initial state
      return this.stateToChanges(newState);
    }

    return this.diff(oldState, newState);
  }

  /**
   * Trigger an immediate poll (called when a CDP event hints at a change).
   * Debounced: multiple triggers within 50ms collapse to one poll.
   */
  triggerPoll(targetId: string) {
    // Reset timer for immediate poll
  }

  private diff(old: PageState, now: PageState): StateChange[] {
    const changes: StateChange[] = [];
    if (!old.hasCfChallenge && now.hasCfChallenge)
      changes.push({ type: 'cf_detected', state: now });
    if (old.hasCfChallenge && !now.hasCfChallenge && now.solved)
      changes.push({ type: 'cf_solved', state: now });
    if (!old.hasWidget && now.hasWidget)
      changes.push({ type: 'widget_appeared', state: now });
    if (!old.hasError && now.hasError)
      changes.push({ type: 'widget_error', state: now });
    if (old.url !== now.url)
      changes.push({ type: 'navigation', state: now });
    if (!old.solved && now.solved)
      changes.push({ type: 'token_available', state: now });
    return changes;
  }

  private stateToChanges(state: PageState): StateChange[] {
    const changes: StateChange[] = [];
    if (state.hasCfChallenge) changes.push({ type: 'cf_detected', state });
    if (state.hasWidget) changes.push({ type: 'widget_appeared', state });
    if (state.solved) changes.push({ type: 'token_available', state });
    return changes;
  }

  stopPolling(targetId: string) {
    const timer = this.pollTimers.get(targetId);
    if (timer) clearInterval(timer);
    this.pollTimers.delete(targetId);
    this.knownState.delete(targetId);
  }
}

interface StateChange {
  type: 'cf_detected' | 'cf_solved' | 'widget_appeared' | 'widget_error'
       | 'navigation' | 'token_available';
  state: PageState;
}
```

### 4. Fix Iframe Parent Mapping

Replaces the dangerous `.pop()` fallback with proper parent tracking.

```typescript
// Add to ReplayCoordinator
private sessionToTarget = new Map<string, string>(); // cdpSessionId → targetId

// When a page attaches:
// Target.attachedToTarget (type=page)
sessionToTarget.set(cdpSessionId, targetId);

// When an iframe attaches:
// Target.attachedToTarget (type=iframe)
// With flatten=true, msg.sessionId is the OUTER session (the page that triggered setAutoAttach)
const parentCdpSid = msg.sessionId;  // This IS the parent page's CDP session
const parentTargetId = sessionToTarget.get(parentCdpSid);

if (!parentTargetId) {
  // Log a warning instead of silently picking wrong parent
  log.warn(`Iframe ${targetId} has no known parent session ${msg.sessionId}`);
}

// REMOVE the dangerous fallback:
// const parentCdpSid = msg.sessionId || [...targetSessions.values()].pop();  // ← DELETE THIS
```

### 5. Unified CF Solver (Poll-Based)

The refactored solver treats CDP events as acceleration hints. The poll loop is the source of truth.

```typescript
class CloudflareSolverV2 {
  private statePoller: StatePoller;
  private eventQueue: ClientEventQueue;
  private activeDetections = new Map<string, ActiveDetection>();

  constructor(
    private cdp: CDPConnection,
    statePoller: StatePoller,
    eventQueue: ClientEventQueue,
  ) {
    this.statePoller = statePoller;
    this.eventQueue = eventQueue;
  }

  /**
   * Start monitoring a page for Cloudflare challenges.
   * Uses polling as source of truth, CDP events as acceleration.
   */
  async monitorPage(targetId: string, cdpSessionId: string) {
    // Start polling (self-healing — doesn't depend on events)
    for await (const change of this.statePoller.startPolling(targetId, cdpSessionId)) {
      switch (change.type) {
        case 'cf_detected':
          await this.handleDetection(targetId, cdpSessionId, change.state);
          break;
        case 'cf_solved':
          await this.handleSolved(targetId, change.state);
          break;
        case 'widget_appeared':
          await this.handleWidget(targetId, cdpSessionId, change.state);
          break;
        case 'widget_error':
          await this.handleError(targetId, cdpSessionId);
          break;
        case 'token_available':
          await this.handleToken(targetId, change.state);
          break;
      }
    }
  }

  /**
   * CDP event hint — triggers immediate poll instead of waiting for next cycle.
   * If the event is dropped, the next scheduled poll catches it.
   */
  onCDPHint(targetId: string, hint: string) {
    this.statePoller.triggerPoll(targetId);
  }
}
```

---

## Implementation Priority

### Phase 1: Immediate Fixes (stops events from dropping)

These fix the most critical failures without requiring architectural changes.

| Fix | Effort | Impact | Files |
|---|---|---|---|
| `ClientEventQueue` — buffer pre-connection events | Small | Fixes silent event loss during CDPProxy gap | `cloudflare-solver.ts`, `browsers.cdp.ts` |
| Route per-page WS events to main handler | Small | Fixes events dropped on page-level WS | `replay-coordinator.ts` |
| Fix iframe parent mapping (remove `.pop()`) | Small | Fixes wrong-tab CF events with multi-tab | `replay-coordinator.ts` |
| Log dropped events (replace `.catch(() => {})`) | Small | Makes failures visible instead of silent | `cloudflare-solver.ts` |

### Phase 2: Reduce Contention (eliminates timeouts)

| Fix | Effort | Impact | Files |
|---|---|---|---|
| Unified state JS (1 evaluate instead of 5) | Medium | 5x fewer CDP round-trips under contention | `cloudflare-solver.ts`, `cloudflare-detection.ts` |
| `CDPConnection` class with routing + timeouts | Medium | Clean WS management, no hanging promises | New file: `cdp-connection.ts` |
| Proper per-page WS lifecycle (open early, close on destroy) | Medium | Per-tab isolation for all operations | `replay-coordinator.ts` |

### Phase 3: Architecture Shift (self-healing system)

| Fix | Effort | Impact | Files |
|---|---|---|---|
| `StatePoller` with diff-based detection | Large | System works even when events are dropped | New file: `state-poller.ts` |
| Event acceleration (CDP events trigger polls) | Medium | Best of both worlds: fast + reliable | `replay-coordinator.ts`, `cloudflare-solver.ts` |
| Reject pending commands on WS close | Small | No more hanging promises | `cdp-connection.ts` |
| Buffered event subscriptions | Large | mafredri/cdp-style reliability in Node.js | `cdp-connection.ts` |

### Migration Path

Phase 1 and 2 can be done incrementally within the existing architecture. Phase 3 is a parallel implementation — build the new poll-based solver alongside the old one, switch over per-page once validated, then remove the old code.

```
Phase 1: Fix holes in current architecture     ──► Deploy, validate
Phase 2: Reduce CDP round-trips                 ──► Deploy, validate
Phase 3: Build poll-based solver alongside old  ──► A/B test ──► Switch over
```
