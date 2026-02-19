import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  Request,
  contentTypes,
  writeResponse,
} from '@browserless.io/browserless';
import { ServerResponse } from 'http';
import { register } from '../../../prom-metrics.js';

export default class PromMetricsGetRoute extends HTTPRoute {
  name = BrowserlessRoutes.PromMetricsGetRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.text];
  description = `Returns Prometheus metrics for Node.js process internals (event loop lag, heap, active handles, GC) and custom replay-coordinator gauges.`;
  method = Methods.get;
  path = HTTPManagementRoutes.promMetrics;
  tags = [APITags.management];
  async handler(_req: Request, res: ServerResponse): Promise<void> {
    const metrics = await register.metrics();
    return writeResponse(res, 200, metrics, contentTypes.text);
  }
}
