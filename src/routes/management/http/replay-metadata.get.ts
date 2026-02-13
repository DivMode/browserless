import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  NotFound,
  ReplayMetadata,
  Request,
  SystemQueryParameters,
  contentTypes,
  jsonResponse,
} from '@browserless.io/browserless';
import { ServerResponse } from 'http';

export interface QuerySchema extends SystemQueryParameters {
  token?: string;
}

export type ResponseSchema = ReplayMetadata;

export default class ReplayMetadataGetRoute extends HTTPRoute {
  name = BrowserlessRoutes.ReplayMetadataGetRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = `Get metadata for a specific session replay by ID (no events).`;
  method = Methods.get;
  path = HTTPManagementRoutes.replayMetadata;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    const replay = this.sessionReplay();
    if (!replay) {
      return jsonResponse(res, 503, { error: 'Session replay is not enabled' });
    }

    // Extract replay ID from path: /replays/:id/metadata
    const pathParts = req.parsed.pathname.split('/');
    const metadataIndex = pathParts.indexOf('metadata');
    const id = metadataIndex > 0 ? pathParts[metadataIndex - 1] : undefined;

    if (!id) {
      throw new NotFound('Replay ID is required');
    }

    const result = await replay.getReplayMetadata(id);
    if (!result) {
      throw new NotFound(`Replay "${id}" not found`);
    }

    return jsonResponse(res, 200, result);
  }
}
