/**
 * Shared types for the CF bridge — runs in the browser.
 * Compiled by esbuild into an IIFE, injected via addScriptToEvaluateOnNewDocument.
 */

/** Events pushed from browser → server, multiplexed through __rrwebPush binding. */
export type BridgeEvent =
  | { type: "detected"; method: string; cType?: string; cRay?: string }
  | { type: "solved"; token: string; tokenLength: number }
  | { type: "error"; errorType: string; hasToken: boolean }
  | { type: "still_detected"; detected: boolean }
  | { type: "timing"; event: string; ts: number };

/** Emit function — pushes a BridgeEvent to the server. */
export type Emit = (event: BridgeEvent) => void;

declare global {
  interface Window {
    _cf_chl_opt?: { cType?: string; cRay?: string };
    turnstile?: {
      render: (container: any, params: any) => string;
      getResponse: (widgetId?: string) => string | null;
      isExpired: (widgetId?: string) => boolean;
      __cbHooked?: boolean;
      __grHooked?: boolean;
    };
    __turnstileSolved?: boolean;
    __turnstileTokenLength?: number;
    __turnstileRenderParams?: object;
    __turnstileRenderTime?: number;
    __turnstileWidgetId?: string | null;
    __rrwebPush?: (payload: string) => void;
  }
}
