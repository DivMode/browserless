/// <reference path="./globals.d.ts" />

// Prevent double-init (extension re-injects on SPA navigations in some cases)
if (window.__browserlessRecording) {
  // Already initialized — bail out (this is the top-level early exit)
} else {
  const isIframe = window !== window.top;

  // -- Iframe: minimal setup -----------------------------------------------
  // rrweb auto-detects cross-origin context and PostMessages events to parent.
  // The parent frame's rrweb instance (recordCrossOriginIframes: true) merges them.
  if (isIframe) {
    window.__browserlessRecording = true;
    const recordFn = window.rrweb && window.rrweb.record;
    if (typeof recordFn === 'function') {
      recordFn({
        emit() {},
        recordCrossOriginIframes: true,
        recordAfter: 'DOMContentLoaded',
        recordCanvas: true,
        collectFonts: true,
        inlineImages: false,
        sampling: { mousemove: true, mouseInteraction: true, scroll: 150, media: 800, input: 'last', canvas: 2 },
        dataURLOptions: { type: 'image/webp', quality: 0.6, maxBase64ImageLength: 2097152 },
      });
    }
  } else {
    // -- Main frame: full recording ----------------------------------------
    const rec: BrowserlessRecording = { events: [], sessionId: '' };
    window.__browserlessRecording = rec;

    // Diagnostic: log pre-init state to help debug empty replays
    console.log(
      '[browserless-ext] pre-init:',
      'rrweb=' + typeof window.rrweb,
      'record=' + typeof (window.rrweb && window.rrweb.record),
      'readyState=' + document.readyState,
      'body=' + !!document.body,
      'docEl=' + !!document.documentElement,
    );

    const consolePlugin =
      window.rrwebConsolePlugin && window.rrwebConsolePlugin.getRecordConsolePlugin
        ? window.rrwebConsolePlugin.getRecordConsolePlugin({
            level: ['error', 'warn', 'info', 'log', 'debug'],
            lengthThreshold: 500,
          })
        : null;

    try {
      window.__browserlessStopRecording = window.rrweb.record({
        emit(event: any) {
          if (!rec || rec === (true as any)) return;
          // Push-based delivery if CDP binding available
          if (window.__rrwebPush) {
            const buf = rec._buf || (rec._buf = []);
            buf.push(event);
            if (!rec._ft) {
              rec._ft = setTimeout(() => {
                rec._ft = null;
                const b = rec._buf;
                rec._buf = [];
                if (b && b.length) {
                  try {
                    window.__rrwebPush!(JSON.stringify(b));
                  } catch (e) {
                    for (let i = 0; i < b.length; i++) rec.events.push(b[i]);
                  }
                }
              }, 500);
            }
          } else {
            rec.events.push(event);
          }
        },
        sampling: { mousemove: true, mouseInteraction: true, scroll: 150, media: 800, input: 'last', canvas: 2 },
        recordCanvas: true,
        collectFonts: true,
        recordCrossOriginIframes: true,
        recordAfter: 'DOMContentLoaded',
        inlineImages: false,
        dataURLOptions: { type: 'image/webp', quality: 0.6, maxBase64ImageLength: 2097152 },
        plugins: consolePlugin ? [consolePlugin] : [],
      });
      console.log('[browserless-ext] rrweb started, stopFn=' + typeof window.__browserlessStopRecording);
    } catch (e: any) {
      console.error('[browserless-ext] rrweb.record() FAILED:', e.message, e.stack);
      rec._rrwebError = e.message;
    }
  }
}
