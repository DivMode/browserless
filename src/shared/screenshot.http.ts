import {
  APITags,
  BadRequest,
  BrowserHTTPRoute,
  BrowserInstance,
  BrowserlessRoutes,
  CDPLaunchOptions,
  ChromiumCDP,
  HTTPRoutes,
  Methods,
  Request,
  SystemQueryParameters,
  UnwrapPromise,
  WaitForEventOptions,
  WaitForFunctionOptions,
  WaitForSelectorOptions,
  bestAttempt,
  bestAttemptCatch,
  contentTypes,
  dedent,
  isBase64Encoded,
  noop,
  rejectRequestPattern,
  rejectResourceTypes,
  requestInterceptors,
  scrollThroughPage,
  sleep,
  waitForEvent as waitForEvt,
  waitForFunction as waitForFn,
} from '@browserless.io/browserless';
import { ElementHandle, Page } from 'puppeteer-core';
import { Effect } from 'effect';
import { ServerResponse } from 'http';
import { runForkInServer } from '../otel-runtime.js';
import Stream from 'stream';

export interface QuerySchema extends SystemQueryParameters {
  launch?: CDPLaunchOptions | string;
}

/**
 * Response can either be a text/plain base64 encoded body
 * or a binary stream with png/jpeg as a content-type
 */
export type ResponseSchema = string;

export interface BodySchema {
  addScriptTag?: Array<Parameters<Page['addScriptTag']>[0]>;
  addStyleTag?: Array<Parameters<Page['addStyleTag']>[0]>;
  authenticate?: Parameters<Page['authenticate']>[0];
  bestAttempt?: bestAttempt;
  cookies?: Array<Parameters<Page['setCookie']>[0]>;
  emulateMediaType?: Parameters<Page['emulateMediaType']>[0];
  gotoOptions?: Parameters<Page['goto']>[1];
  html?: Parameters<Page['setContent']>[0];
  options?: Parameters<Page['screenshot']>[0];
  rejectRequestPattern?: rejectRequestPattern[];
  rejectResourceTypes?: rejectResourceTypes[];
  requestInterceptors?: Array<requestInterceptors>;
  scrollPage?: boolean;
  selector?: string;
  setExtraHTTPHeaders?: Parameters<Page['setExtraHTTPHeaders']>[0];
  setJavaScriptEnabled?: boolean;
  url?: Parameters<Page['goto']>[0];
  userAgent?: Parameters<Page['setUserAgent']>[0];
  viewport?: Parameters<Page['setViewport']>[0];
  waitForEvent?: WaitForEventOptions;
  waitForFunction?: WaitForFunctionOptions;
  waitForSelector?: WaitForSelectorOptions;
  waitForTimeout?: number;
}

export default class ScreenshotPost extends BrowserHTTPRoute {
  name = BrowserlessRoutes.ChromiumScreenshotPostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = ChromiumCDP;
  concurrency = true;
  contentTypes = [contentTypes.png, contentTypes.jpeg, contentTypes.text];
  description = dedent(`
    A JSON-based API for getting a screenshot binary from either a supplied
    "url" or "html" payload in your request. Many options exist including
    cookies, user-agents, setting timers and network mocks.
  `);
  method = Methods.post;
  path = [HTTPRoutes.chromiumScreenshot, HTTPRoutes.screenshot];
  tags = [APITags.browserAPI];
  async handler(
    req: Request,
    res: ServerResponse,
    browser: BrowserInstance,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.fn('route.screenshot.post')(function* () {
        yield* Effect.logInfo('Screenshot API invoked with body: ' + JSON.stringify(req.body));
        const contentType =
          !req.headers.accept || req.headers.accept?.includes('*')
            ? 'image/png'
            : req.headers.accept;

        if (!req.body) {
          throw new BadRequest(`Couldn't parse JSON body`);
        }

        res.setHeader('Content-Type', contentType);

        const {
          url,
          gotoOptions,
          authenticate,
          html,
          addScriptTag = [],
          addStyleTag = [],
          cookies = [],
          emulateMediaType,
          rejectRequestPattern = [],
          requestInterceptors = [],
          rejectResourceTypes = [],
          options,
          scrollPage,
          setExtraHTTPHeaders,
          setJavaScriptEnabled,
          userAgent,
          viewport,
          waitForTimeout,
          waitForFunction,
          waitForSelector,
          waitForEvent,
          selector,
          bestAttempt = false,
        } = req.body as BodySchema;

        if (options?.path) {
          throw new BadRequest(`"path" option is not allowed`);
        }

        const content = url || html;

        if (!content) {
          throw new BadRequest(`One of "url" or "html" properties are required.`);
        }

        const page = (yield* Effect.promise(() =>
          Promise.resolve(browser.newPage()),
        )) as UnwrapPromise<ReturnType<ChromiumCDP['newPage']>>;
        const gotoCall = url ? page.goto.bind(page) : page.setContent.bind(page);

        if (emulateMediaType) {
          yield* Effect.promise(() => page.emulateMediaType(emulateMediaType));
        }

        if (cookies.length) {
          yield* Effect.promise(() => page.setCookie(...cookies));
        }

        if (viewport) {
          yield* Effect.promise(() => page.setViewport(viewport));
        }

        if (userAgent) {
          yield* Effect.promise(() => page.setUserAgent(userAgent));
        }

        if (authenticate) {
          yield* Effect.promise(() => page.authenticate(authenticate));
        }

        if (setExtraHTTPHeaders) {
          yield* Effect.promise(() => page.setExtraHTTPHeaders(setExtraHTTPHeaders));
        }

        if (setJavaScriptEnabled) {
          yield* Effect.promise(() => page.setJavaScriptEnabled(setJavaScriptEnabled));
        }

        if (
          rejectRequestPattern.length ||
          requestInterceptors.length ||
          rejectResourceTypes.length
        ) {
          yield* Effect.promise(() => page.setRequestInterception(true));

          page.on('request', (req) => {
            if (
              !!rejectRequestPattern.find((pattern) => req.url().match(pattern)) ||
              rejectResourceTypes.includes(req.resourceType())
            ) {
              runForkInServer(Effect.logDebug(`Aborting request ${req.method()}: ${req.url()}`));
              return req.abort();
            }
            const interceptor = requestInterceptors.find((r) =>
              req.url().match(r.pattern),
            );
            if (interceptor) {
              return req.respond({
                ...interceptor.response,
                body: interceptor.response.body
                  ? isBase64Encoded(interceptor.response.body as string)
                    ? Buffer.from(interceptor.response.body, 'base64')
                    : interceptor.response.body
                  : undefined,
              });
            }
            return req.continue();
          });
        }

        const gotoResponse = yield* Effect.promise(() =>
          gotoCall(content, gotoOptions).catch(bestAttemptCatch(bestAttempt)),
        );

        if (addStyleTag.length) {
          for (const tag in addStyleTag) {
            yield* Effect.promise(() => page.addStyleTag(addStyleTag[tag]));
          }
        }

        if (addScriptTag.length) {
          for (const tag in addScriptTag) {
            yield* Effect.promise(() => page.addScriptTag(addScriptTag[tag]));
          }
        }

        if (waitForTimeout) {
          yield* Effect.promise(() =>
            sleep(waitForTimeout).catch(bestAttemptCatch(bestAttempt)),
          );
        }

        if (waitForFunction) {
          yield* Effect.promise(() =>
            waitForFn(page, waitForFunction).catch(bestAttemptCatch(bestAttempt)),
          );
        }

        if (waitForSelector) {
          const { selector, hidden, timeout, visible } = waitForSelector;
          yield* Effect.promise(() =>
            page
              .waitForSelector(selector, { hidden, timeout, visible })
              .catch(bestAttemptCatch(bestAttempt)),
          );
        }

        if (waitForEvent) {
          yield* Effect.promise(() =>
            waitForEvt(page, waitForEvent).catch(bestAttemptCatch(bestAttempt)),
          );
        }

        if (scrollPage) {
          yield* Effect.promise(() => scrollThroughPage(page));
        }

        const headers = {
          'X-Response-Code': gotoResponse?.status(),
          'X-Response-IP': gotoResponse?.remoteAddress().ip,
          'X-Response-Port': gotoResponse?.remoteAddress().port,
          'X-Response-Status': gotoResponse?.statusText(),
          'X-Response-URL': gotoResponse?.url().substring(0, 1000),
        };

        for (const [key, value] of Object.entries(headers)) {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        }

        const target: ElementHandle | Page | null = selector
          ? yield* Effect.promise(() => page.$(selector))
          : page;

        if (!target) {
          throw new BadRequest('Element not found on page!');
        }

        const buffer = (yield* Effect.promise(() =>
          (target as Page).screenshot(options),
        )) as Buffer;

        const readStream = new Stream.PassThrough();
        readStream.end(buffer);

        yield* Effect.promise(() => new Promise((r) => readStream.pipe(res).once('close', r)));

        page.close().catch(noop);
        yield* Effect.logDebug('Screenshot API request completed');
      })(),
    );
  }
}
