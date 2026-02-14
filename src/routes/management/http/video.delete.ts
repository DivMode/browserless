import {
  APITags,
  BrowserlessRoutes,
  HTTPManagementRoutes,
  HTTPRoute,
  Methods,
  NotFound,
  Request,
  SystemQueryParameters,
  contentTypes,
  jsonResponse,
} from '@browserless.io/browserless';
import { ServerResponse } from 'http';

export interface QuerySchema extends SystemQueryParameters {
  token?: string;
}

export interface ResponseSchema {
  deleted: boolean;
  id: string;
}

export default class VideoDeleteRoute extends HTTPRoute {
  name = BrowserlessRoutes.VideoDeleteRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = `Delete video frames for a replay, keeping the rrweb recording.`;
  method = Methods.delete;
  path = HTTPManagementRoutes.video;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    const video = this.videoManager();
    if (!video) {
      return jsonResponse(res, 503, { error: 'Video manager is not enabled' });
    }

    // Extract replay ID from path: /video/:id
    const pathParts = req.parsed.pathname.split('/');
    const videoIndex = pathParts.indexOf('video');
    const id = videoIndex >= 0 && videoIndex + 1 < pathParts.length
      ? pathParts[videoIndex + 1]
      : null;

    if (!id) {
      throw new NotFound('Replay ID is required');
    }

    const deleted = await video.deleteVideoFrames(id);
    if (!deleted) {
      throw new NotFound(`Video frames for replay "${id}" not found`);
    }

    return jsonResponse(res, 200, { deleted: true, id });
  }
}
