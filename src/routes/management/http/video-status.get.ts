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
} from "@browserless.io/browserless";
import { ServerResponse } from "http";
import { Effect } from "effect";

export interface QuerySchema extends SystemQueryParameters {
  token?: string;
}

/**
 * JSON endpoint for real-time encoding progress.
 * Polled by the player page every 1s during encoding.
 *
 * Returns base status from SQLite, overlaid with real-time
 * progress (framesProcessed, fps) from the encoder's in-memory Map.
 */
export default class VideoStatusGetRoute extends HTTPRoute {
  name = BrowserlessRoutes.VideoStatusGetRoute;
  accepts = [contentTypes.any];
  auth = true;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.json];
  description = `Get video encoding status and progress for a replay.`;
  method = Methods.get;
  path = HTTPManagementRoutes.videoStatus;
  tags = [APITags.management];

  async handler(req: Request, res: ServerResponse): Promise<void> {
    const route = this;
    return Effect.runPromise(
      Effect.fn("route.video-status.get")(function* () {
        const video = route.videoManager();
        if (!video) {
          return jsonResponse(res, 503, {
            error: "Video manager is not enabled",
          });
        }

        // Extract replay ID from path: /video/:id/status
        const pathParts = req.parsed.pathname.split("/");
        const videoIndex = pathParts.indexOf("video");
        const id =
          videoIndex >= 0 && videoIndex + 1 < pathParts.length ? pathParts[videoIndex + 1] : null;

        if (!id) {
          throw new NotFound("Replay ID is required");
        }

        const encoder = video.getVideoEncoder();
        const progress = encoder?.getProgress(id) ?? null;

        if (!progress) {
          throw new NotFound(`No encoding progress for "${id}"`);
        }

        const response = {
          encodingStatus: progress.status,
          frameCount: progress.totalFrames,
          framesProcessed: progress.framesProcessed,
          fps: progress.fps,
          percent:
            progress.totalFrames > 0
              ? Math.min(100, Math.round((progress.framesProcessed / progress.totalFrames) * 100))
              : 0,
        };

        return jsonResponse(res, 200, response);
      })(),
    );
  }
}
