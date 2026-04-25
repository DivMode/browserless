/// <reference path="./globals.d.ts" />

// Always re-initialize — CF redirects create new documents but
// __browserlessRecording may persist from the previous page in MAIN world.
// The old guard caused zero-event replays on redirected pages.
if (window.__browserlessRecording && window.__browserlessStopRecording) {
  try {
    window.__browserlessStopRecording();
  } catch {}
}
window.__browserlessRecording = undefined as any;
{
  const isIframe = window !== window.top;

  // -- Iframe: minimal setup -----------------------------------------------
  // rrweb auto-detects cross-origin context and PostMessages events to parent.
  // The parent frame's rrweb instance (recordCrossOriginIframes: true) merges them.
  if (isIframe) {
    window.__browserlessRecording = true;
    const recordFn = window.rrweb && window.rrweb.record;
    console.log(
      "[browserless-ext] iframe-init:",
      "rrweb=" + typeof window.rrweb,
      "record=" + typeof recordFn,
      "origin=" + location.origin,
      "url=" + location.href.substring(0, 80),
    );
    if (typeof recordFn === "function") {
      try {
        const stop = recordFn({
          emit() {},
          recordCrossOriginIframes: true,
          recordAfter: "DOMContentLoaded",
          recordCanvas: true,
          collectFonts: true,
          inlineImages: false,
          sampling: {
            mousemove: true,
            mouseInteraction: true,
            scroll: 150,
            media: 800,
            input: "last",
            canvas: 2,
          },
          dataURLOptions: { type: "image/webp", quality: 0.6, maxBase64ImageLength: 2097152 },
        });
        console.log(
          "[browserless-ext] iframe-record-ok:",
          "stop=" + typeof stop,
          "origin=" + location.origin,
        );
      } catch (e) {
        const err = e as Error;
        console.error(
          "[browserless-ext] iframe-record-FAILED:",
          (err && err.message) || String(e),
          "origin=" + location.origin,
        );
      }
    }
  } else {
    // -- Main frame: full recording ----------------------------------------
    const rec: BrowserlessRecording = { events: [], sessionId: "" };
    window.__browserlessRecording = rec;

    // Diagnostic: log pre-init state to help debug empty replays
    console.log(
      "[browserless-ext] pre-init:",
      "rrweb=" + typeof window.rrweb,
      "record=" + typeof (window.rrweb && window.rrweb.record),
      "readyState=" + document.readyState,
      "body=" + !!document.body,
      "isTop=" + (window.parent === window),
      "url=" + location.href.substring(0, 60),
    );

    const consolePlugin =
      window.rrwebConsolePlugin && window.rrwebConsolePlugin.getRecordConsolePlugin
        ? window.rrwebConsolePlugin.getRecordConsolePlugin({
            level: ["error", "warn", "info", "log", "debug"],
            lengthThreshold: 500,
          })
        : null;

    try {
      window.__browserlessStopRecording = window.rrweb.record({
        emit(event: any) {
          if (!rec || rec === (true as any)) return;
          // Always buffer first, push at flush time. The extension runs at
          // document_start which races with Phase 1's Runtime.addBinding for
          // __rrwebPush. If we check __rrwebPush at emit time, the initial
          // FullSnapshot may land in rec.events (never pushed) because the
          // binding isn't registered yet. By deferring the check to flush
          // time (500ms later), Phase 1 has always completed.
          const buf = rec._buf || (rec._buf = []);
          buf.push(event);
          if (!rec._ft) {
            rec._ft = setTimeout(() => {
              rec._ft = null;
              const b = rec._buf;
              rec._buf = [];
              if (b && b.length) {
                if (window.__rrwebPush) {
                  try {
                    window.__rrwebPush(JSON.stringify(b));
                  } catch (e) {
                    for (let i = 0; i < b.length; i++) rec.events.push(b[i]);
                  }
                } else {
                  for (let i = 0; i < b.length; i++) rec.events.push(b[i]);
                }
              }
            }, 500);
          }
        },
        sampling: {
          mousemove: true,
          mouseInteraction: true,
          scroll: 150,
          media: 800,
          input: "last",
          canvas: 2,
        },
        recordCanvas: true,
        collectFonts: true,
        recordCrossOriginIframes: true,
        recordAfter: "DOMContentLoaded",
        inlineImages: false,
        dataURLOptions: { type: "image/webp", quality: 0.6, maxBase64ImageLength: 2097152 },
        plugins: consolePlugin ? [consolePlugin] : [],
      });
      console.log(
        "[browserless-ext] rrweb started, stopFn=" + typeof window.__browserlessStopRecording,
        "pushAvail=" + !!window.__rrwebPush,
        "url=" + location.href.substring(0, 60),
      );
    } catch (e: any) {
      console.error("[browserless-ext] rrweb.record() FAILED:", e.message, e.stack);
      rec._rrwebError = e.message;
    }
  }
}
