# CDP Iframe Freeze: Runtime.evaluate Hangs on Pages with Cross-Origin Iframes

## Status: UNRESOLVED

This bug is **not fixed**. Pages with cross-origin iframes cannot be visited when `replay=true` is enabled. Known affected: `webscraper.io/bot-check` (embeds `d1exrvfwzmo830.cloudfront.net/checkbox-iframe.html` via `sandbox="allow-scripts"`).

The root cause analysis and proposed fixes below have not been successfully deployed and verified.

## The Bug

`Runtime.evaluate` hangs forever on pages that contain sandboxed cross-origin iframes (e.g., `webscraper.io/bot-check` which embeds `d1exrvfwzmo830.cloudfront.net/checkbox-iframe.html` via `sandbox="allow-scripts"`). The CDP command never returns, causing pydoll's `_wait_page_load` to time out after 60 seconds.

## Root Cause

`Target.setAutoAttach({waitForDebuggerOnStart: true})` pauses iframe targets that nobody resumes. Multiple CDP sessions call this — the replay-coordinator (browser-level and page-level) and puppeteer's TargetManager (on every discovered page session). When an iframe target is paused, the page's `load` event never fires because it waits for all frames to finish loading. This blocks `document.readyState` from reaching `"complete"`, causing pydoll's `_wait_page_load` to time out at 60s.

The replay-coordinator connects a separate WebSocket to Chrome's browser-level CDP endpoint and calls:

```typescript
Target.setAutoAttach({
  autoAttach: true,
  waitForDebuggerOnStart: true,  // THE PROBLEM
  flatten: true,
})
```

This pauses ALL new targets in the browser's scope — including iframe targets. The browser-level `setAutoAttach` doesn't fire `attachedToTarget` for iframe targets (iframes are children of pages, not the browser), so the replay-coordinator never sees them and never resumes them via `Runtime.runIfWaitingForDebugger`.

Additionally, puppeteer's TargetManager (created by `puppeteer.launch()`) calls `setAutoAttach({waitForDebuggerOnStart: true})` on every discovered page session, pausing iframe children of those pages too. See "Proposed Approach: targetFilter" section below.

**Note:** `--disable-features=IsolateOrigins,site-per-process` (previously in `browser.py`) makes this worse — iframes share the parent's V8 isolate, so pausing them freezes `Runtime.evaluate` directly. But removing the flag does NOT fix the bug. See "Why Removing the Site Isolation Flag Didn't Fix It" below.

## Why It's Not Visible

The iframe target doesn't generate a `Target.attachedToTarget` event on the browser-level CDP connection because:
1. Browser-level auto-attach only notifies about **direct children of the browser** (pages, workers)
2. Iframes are children of pages, so `attachedToTarget` only fires on page-level sessions
3. The replay-coordinator had page-level `setAutoAttach` with `waitForDebuggerOnStart: false` — correct, but irrelevant since the browser-level session already paused the target

Chrome's behavior: when ANY CDP session's auto-attach has `waitForDebuggerOnStart: true`, new targets matching that session's scope get paused. The browser-level scope includes all targets in the browser process, including in-process iframes.

## Why Ahrefs Works But Botcheck Didn't

**Timing.** Ahrefs's Turnstile iframe (`challenges.cloudflare.com`) loads dynamically AFTER page load completes — by the time the iframe creates an in-process target, pydoll's `Runtime.evaluate` has already returned. The V8 freeze only blocks *in-flight* evaluations.

Botcheck's iframe is created by JavaScript in the initial page HTML (`document.createElement("iframe")` with `sandbox="allow-scripts"`). It loads DURING the page's initial JavaScript execution, before `document.readyState` reaches "complete". Pydoll's `_wait_page_load` polls `Runtime.evaluate('document.readyState')` in a loop — the in-flight evaluate gets frozen when the iframe target is paused.

**Note:** With site isolation disabled, the iframe doesn't generate a separate CDP target that's visible to the replay-coordinator's auto-attach handler. The target exists internally in Chrome but is only reported to sessions with appropriate scope. This made the bug invisible in logs — no `Iframe target attached` events appeared for the botcheck session.

## Proposed Fix (not yet applied)

Add a `filter` to the browser-level `Target.setAutoAttach` to exclude iframe targets from being paused:

```typescript
await sendCommand('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: 'browser', exclude: true },  // Required: Chrome forbids tab+page overlap
    { type: 'tab', exclude: true },       // Required: pages attach via tabs internally
    { type: 'iframe', exclude: true },    // Don't pause iframes (V8 isolate freeze)
    {},  // Include everything else (pages, workers, etc.)
  ],
});
```

### Why `browser` and `tab` exclusions are required

Chrome's `Target.setAutoAttach` filter is evaluated sequentially — the first matching entry wins. When no filter is specified, Chrome uses this default:

```typescript
[{type: "browser", exclude: true}, {type: "tab", exclude: true}, {}]
```

Chrome enforces a strict rule: **a filter must not simultaneously allow both `tab` and `page` target types**. This is because pages are internally attached via tabs (browser → tab → page hierarchy). If a catch-all `{}` entry matches without prior `browser`/`tab` exclusions, it matches ALL types including both `tab` and `page`, and Chrome rejects the entire `setAutoAttach` call with:

> "Filter should not simultaneously allow 'tab' and 'page', page targets are attached via tab targets"

When the call fails, it falls into the catch block and **no targets are auto-attached at all** — no rrweb injection, no recordings. Any custom filter must replicate Chrome's base exclusions (`browser` and `tab`) before the catch-all entry.

### Three `setAutoAttach` calls in replay-coordinator.ts

| Location | Scope | `waitForDebuggerOnStart` | Filter | Purpose |
|----------|-------|--------------------------|--------|---------|
| ~line 718 | Browser-level | `true` | `iframe` excluded | Pause new **pages** for rrweb pre-injection |
| ~line 442 | Page-level (initial) | `false` | none | Detect **iframe** children for rrweb injection |
| ~line 684 | Page-level (nav re-setup) | `false` | none | Re-detect iframes after page navigation |

All three are necessary:

- **Browser-level** catches page targets (new tabs). Pages get paused for rrweb `addScriptToEvaluateOnNewDocument` pre-injection. The `filter` excludes iframe targets — without this, `waitForDebuggerOnStart: true` pauses iframes even though browser-level auto-attach doesn't fire `attachedToTarget` for them, so nobody resumes them.
- **Page-level (initial)** is set inside the `attachedToTarget` handler for each new page. With `waitForDebuggerOnStart: false`, it detects iframe children without pausing them. rrweb is injected via `addScriptToEvaluateOnNewDocument({runImmediately: true})` after attachment.
- **Page-level (nav re-setup)** re-establishes page-level auto-attach after `targetInfoChanged` (page navigation). Ensures iframes created on the new page are still detected.

## Why Removing the Site Isolation Flag Didn't Fix It

The `--disable-features=IsolateOrigins,site-per-process` flag was removed from `browser.py` (it's detectable and unnecessary for CDP). But this **did not fix the deadlock**.

With site isolation enabled, cross-origin iframes get their own V8 isolate, so pausing them no longer freezes the parent's V8. However, the page's `load` event still waits for **all frames** (including cross-origin ones in separate processes) to finish loading. A paused iframe target can't proceed with loading → the `load` event never fires → `document.readyState` never reaches `"complete"` → pydoll's `_wait_page_load` times out at 60s.

The V8 freeze was a symptom, not the root cause. The root cause is **any CDP session calling `setAutoAttach({waitForDebuggerOnStart: true})` that covers iframe targets and never resumes them**.

## Proposed Approach: targetFilter (not yet applied)

The deadlock had two sources of rogue `setAutoAttach` calls:

### 1. replay-coordinator.ts

Two changes:

**Browser-level** `setAutoAttach` (~line 718): Added `filter: [{type: 'iframe', exclude: true}]` to exclude iframe targets from being paused. Chrome's `waitForDebuggerOnStart: true` pauses ALL targets in a session's scope — including iframe targets that the browser-level session doesn't fire `attachedToTarget` for. Without the filter, iframes are paused with nobody to resume them.

```typescript
await sendCommand('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: 'browser', exclude: true },
    { type: 'tab', exclude: true },
    { type: 'iframe', exclude: true },
    {},  // Include everything else (pages, workers, etc.)
  ],
});
```

**Page-level** `setAutoAttach` (~line 442 and ~line 684): Changed from `waitForDebuggerOnStart: true` to `false`. Belt-and-suspenders — even if the browser-level filter somehow fails, iframes detected on the page level won't be paused.

**Why pausing iframes is dangerous:** Puppeteer's default Chrome flags include `--disable-features=IsolateSandboxedIframes`, which means sandboxed cross-origin iframes share the parent page's V8 isolate and renderer process. When `waitForDebuggerOnStart: true` pauses an in-process iframe target, the entire V8 isolate freezes — blocking all `Runtime.evaluate` calls on the parent page. Even without shared V8 (site isolation enabled), the page's `load` event still waits for all frames to finish loading. A paused iframe can't load → `document.readyState` never reaches `"complete"` → pydoll's `_wait_page_load` times out at 60s.

**Tradeoff:** Iframes get rrweb injected via `addScriptToEvaluateOnNewDocument({runImmediately: true})` after attachment (~100ms delay) instead of pre-injection while paused. This is negligible because iframe content loads over network (100-500ms), and `addScriptToEvaluateOnNewDocument` persists across iframe navigations.

### 2. puppeteer's core TargetManager

Both `puppeteer.launch()` and `puppeteerStealth.launch()` create a `TargetManager` — it's core puppeteer, not stealth-specific. The TargetManager calls `Target.setAutoAttach({waitForDebuggerOnStart: true})` on **every discovered page session**, including pydoll's pages. This pauses iframe targets on those pages that puppeteer never resumes (browserless's `onTargetCreated` returns early for external clients because `pendingInternalPage` is false).

**Fix — `targetFilter` on launch** (`browsers.cdp.ts`):

```typescript
this.browser = await launch({
  ...finalOptions,
  targetFilter: (target: Target) => {
    if (target.type() !== 'page') return true;
    return this.pendingInternalPage;
  },
});
```

Only accepts page targets when `pendingInternalPage` is true (set during `newPage()` calls). External clients' pages are rejected → `silentDetach()` → TargetManager never calls `setAutoAttach` on their sessions.

**Requires `waitForInitialPage: false`**: The filter rejects all pages when `pendingInternalPage` is false. Puppeteer's `waitForPageTarget` would timeout after 30s unless the client sends `waitForInitialPage: false` in launch options. Pydoll already does this.

### How the TargetManager creates the deadlock

Tracing through puppeteer's `TargetManager.js`:

1. **`initialize()` (line 85)**: Sends a connection-level `Target.setAutoAttach` with `{type: 'page', exclude: true}` — this attaches to tabs, not pages directly. The browser→tab→page hierarchy means pages are discovered as children of tabs.

2. **`#onAttachedToTarget` (line 204)**: Fires when any target is attached via auto-attach. This is where the damage happens.

3. **Lines 279-287**: For every target that **passes** the filter, the TargetManager sends `session.send('Target.setAutoAttach', {waitForDebuggerOnStart: true, flatten: true, autoAttach: true})` on **that target's CDP session**. This propagates hierarchically: browser → tab → page → iframe. When a page session gets `setAutoAttach({waitForDebuggerOnStart: true})`, any iframe child targets are paused before execution.

4. **The deadlock**: The TargetManager resumes targets it manages via `Runtime.runIfWaitingForDebugger` (line 286). But for external clients' pages (pydoll's pages), browserless's `onTargetCreated` returns early because `pendingInternalPage` is `false` — nobody resumes the iframe children. They stay paused forever.

### How targetFilter prevents it

Tracing through the same `#onAttachedToTarget` handler:

1. **Line 246**: `if (this.#targetFilterCallback && !this.#targetFilterCallback(target))` — the filter is checked for every newly attached target.

2. **Line 247**: If rejected, the target is added to `#ignoredTargets`.

3. **Line 251**: `silentDetach()` is called — this sends `Runtime.runIfWaitingForDebugger` (resumes the target if it was paused) then `Target.detachFromTarget` (detaches the CDP session).

4. **Lines 279-287 never execute** for rejected targets — the function returns at line 252 after `silentDetach()`.

5. **Result**: The rejected page never gets `setAutoAttach` on its session → its iframe children are never paused → no deadlock. The page is completely invisible to puppeteer's management infrastructure.

## Why This Only Affects CDP Proxies

This bug doesn't affect normal puppeteer or browserless users. Understanding why requires understanding puppeteer's ownership model.

### Puppeteer's ownership model

Puppeteer assumes it owns every target in the browser. When `puppeteer.launch()` creates a `Browser`, it creates a `TargetManager` that monitors all targets via the browser-level CDP connection. For every discovered page, the TargetManager calls `Target.setAutoAttach({waitForDebuggerOnStart: true})` on that page's session. This pauses child targets (iframes, workers) before they execute, giving puppeteer a chance to inject scripts via `addScriptToEvaluateOnNewDocument`, then resumes them via `Runtime.runIfWaitingForDebugger`. When puppeteer manages all pages, every paused target gets resumed. No deadlock.

### Normal browserless users

Connect via puppeteer or playwright client libraries. When they request a page, browserless calls `newPage()` internally (setting `pendingInternalPage = true`). Puppeteer creates the page, manages its lifecycle, and the TargetManager correctly handles all child targets — pausing, injecting, resuming. The `onTargetCreated` handler in browserless sees `pendingInternalPage = true` and hands the page to the client. Everything works.

### Our setup (pydoll as external CDP client)

Pydoll connects via raw CDP WebSocket directly to Chrome, bypassing puppeteer entirely. It creates pages through Chrome's `Target.createTarget` CDP command — puppeteer's `newPage()` is never called, so `pendingInternalPage` stays `false`.

But puppeteer's TargetManager still **discovers** these pages. It monitors all targets in the browser and doesn't distinguish between pages it created and pages an external client created. So it calls `setAutoAttach({waitForDebuggerOnStart: true})` on pydoll's page sessions, pausing iframe targets. Browserless's `onTargetCreated` fires but returns early because `pendingInternalPage` is `false` — it knows it didn't create that page. The normal code path that would resume paused targets never executes. The iframe stays paused forever.

### Not a puppeteer bug

Puppeteer was never designed to share a browser with external CDP clients. The TargetManager managing all discovered targets is by design — in the normal use case, every target in the browser belongs to puppeteer. The `targetFilter` option exists for exactly this scenario: telling the TargetManager which targets it actually owns, so it leaves everything else alone.

## Debugging Methodology

**Key test**: Remove `replay=true` from the browserless WebSocket URL. If `Runtime.evaluate` works without replay but hangs with it, the replay-coordinator's CDP session is the cause.

```python
# With replay (hangs)
ws_url = "ws://192.168.4.200:3000?timeout=180000&replay=true"

# Without replay (works)
ws_url = "ws://192.168.4.200:3000?timeout=180000"
```

**Comparative test**: Navigate to pages with and without iframes on the same session:
- `example.com` — works (no iframes)
- `webscraper.io` homepage — works (no cross-origin sandboxed iframes)
- `webscraper.io/bot-check` — hangs (creates sandboxed cross-origin iframe)

## Key Lesson

`Target.setAutoAttach({waitForDebuggerOnStart: true})` on **any** CDP session — browser-level or page-level — can pause iframe targets and block the page's `load` event, regardless of site isolation. With site isolation disabled, pausing an iframe freezes the parent's V8 isolate directly. With site isolation enabled, the iframe can't load, so the `load` event (which waits for all frames) never fires. Either way, `document.readyState` never reaches `"complete"` and `_wait_page_load` times out.

In a CDP proxy like browserless, the most dangerous source is **puppeteer's own TargetManager** (created by every `puppeteer.launch()` call). It calls `setAutoAttach({waitForDebuggerOnStart: true})` on every discovered page session — including pages belonging to external CDP clients that puppeteer doesn't manage. Use `targetFilter` at launch time to restrict which targets the TargetManager manages.
