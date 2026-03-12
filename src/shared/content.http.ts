import {
  APITags,
  BadRequest,
  BrowserHTTPRoute,
  BrowserInstance,
  BrowserlessRoutes,
  CDPLaunchOptions,
  ChromiumCDP,
  HTTPRoutes,
  Logger,
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
  isBase64Encoded,
  noop,
  rejectRequestPattern,
  rejectResourceTypes,
  requestInterceptors,
  setJavaScriptEnabled,
  sleep,
  waitForEvent as waitForEvt,
  waitForFunction as waitForFn,
  writeResponse,
} from '@browserless.io/browserless';
import { Page } from 'puppeteer-core';
import { Effect } from 'effect';
import { ServerResponse } from 'http';

export interface BodySchema {
  addScriptTag?: Array<Parameters<Page['addScriptTag']>[0]>;
  addStyleTag?: Array<Parameters<Page['addStyleTag']>[0]>;
  authenticate?: Parameters<Page['authenticate']>[0];
  bestAttempt?: bestAttempt;
  cookies?: Array<Parameters<Page['setCookie']>[0]>;
  emulateMediaType?: Parameters<Page['emulateMediaType']>[0];
  gotoOptions?: Parameters<Page['goto']>[1];
  html?: Parameters<Page['setContent']>[0];
  rejectRequestPattern?: rejectRequestPattern[];
  rejectResourceTypes?: rejectResourceTypes[];
  requestInterceptors?: Array<requestInterceptors>;
  setExtraHTTPHeaders?: Parameters<Page['setExtraHTTPHeaders']>[0];
  setJavaScriptEnabled?: setJavaScriptEnabled;
  url?: Parameters<Page['goto']>[0];
  userAgent?: Parameters<Page['setUserAgent']>[0];
  viewport?: Parameters<Page['setViewport']>[0];
  waitForEvent?: WaitForEventOptions;
  waitForFunction?: WaitForFunctionOptions;
  waitForSelector?: WaitForSelectorOptions;
  waitForTimeout?: number;
}

/**
 * An HTML payload of the website or HTML after JavaScript
 * parsing and execution.
 */
export type ResponseSchema = string;

export type QuerySchema = SystemQueryParameters & {
  launch?: CDPLaunchOptions | string;
};

export default class ChromiumContentPostRoute extends BrowserHTTPRoute {
  name = BrowserlessRoutes.ChromiumContentPostRoute;
  accepts = [contentTypes.json];
  auth = true;
  browser = ChromiumCDP;
  concurrency = true;
  contentTypes = [contentTypes.html];
  description = `A JSON-based API. Given a "url" or "html" field, runs and returns HTML content after the page has loaded and JavaScript has parsed.`;
  method = Methods.post;
  path = [HTTPRoutes.chromiumContent, HTTPRoutes.content];
  tags = [APITags.browserAPI];
  async handler(
    req: Request,
    res: ServerResponse,
    logger: Logger,
    browser: BrowserInstance,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.fn('route.content.post')(function* () {
        logger.info('Content API invoked with body:', req.body);
        const contentType =
          !req.headers.accept || req.headers.accept?.includes('*')
            ? contentTypes.html
            : req.headers.accept;

        if (!req.body) {
          throw new BadRequest(`Couldn't parse JSON body`);
        }

        res.setHeader('Content-Type', contentType);

        const {
          bestAttempt = false,
          url,
          gotoOptions,
          html,
          authenticate,
          addScriptTag = [],
          addStyleTag = [],
          cookies = [],
          emulateMediaType,
          rejectRequestPattern = [],
          requestInterceptors = [],
          rejectResourceTypes = [],
          setExtraHTTPHeaders,
          setJavaScriptEnabled,
          userAgent,
          viewport,
          waitForTimeout,
          waitForFunction,
          waitForSelector,
          waitForEvent,
        } = req.body as BodySchema;

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
              logger.debug(`Aborting request ${req.method()}: ${req.url()}`);
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

        const markup = yield* Effect.promise(() => page.content());

        page.close().catch(noop);

        logger.info('Content API request completed');

        return writeResponse(res, 200, markup, contentTypes.html);
      })(),
    );
  }
}
