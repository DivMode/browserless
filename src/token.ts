import {
  BrowserHTTPRoute,
  BrowserWebsocketRoute,
  Config,
  HTTPRoute,
  Request,
  WebSocketRoute,
  getTokenFromRequest,
} from '@browserless.io/browserless';
import { EventEmitter } from 'events';
import { Effect } from 'effect';

export class Token extends EventEmitter {
  constructor(protected config: Config) {
    super();
  }

  public isAuthorizedEffect(
    req: Request,
    route:
      | BrowserHTTPRoute
      | BrowserWebsocketRoute
      | HTTPRoute
      | WebSocketRoute,
  ): Effect.Effect<boolean> {
    return Effect.fn('token.isAuthorized')({ self: this }, function* () {
      const token = this.config.getToken();

      if (token === null) {
        return true;
      }

      if (route.auth !== true) {
        return true;
      }

      const requestToken = getTokenFromRequest(req);

      if (!requestToken) {
        return false;
      }

      return (Array.isArray(token) ? token : [token]).includes(requestToken);
    })();
  }

  public async isAuthorized(
    req: Request,
    route:
      | BrowserHTTPRoute
      | BrowserWebsocketRoute
      | HTTPRoute
      | WebSocketRoute,
  ): Promise<boolean> {
    return Effect.runPromise(this.isAuthorizedEffect(req, route));
  }

  /**
   * Implement any browserless-core-specific shutdown logic here.
   * Calls the empty-SDK stop method for downstream implementations.
   */
  public async shutdown() {
    return await this.stop();
  }

  /**
   * Left blank for downstream SDK modules to optionally implement.
   */
  public stop() {}
}
