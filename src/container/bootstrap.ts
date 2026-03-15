import {
  Config,
  FileSystem,
  Hooks,
  Limiter,
  Metrics,
  Monitoring,
  Router,
  Token,
  WebHooks,
} from "@browserless.io/browserless";

import { ServiceContainer } from "./container.js";
import { BrowserManager } from "../browsers/index.js";
import { SessionRegistry } from "../session/session-registry.js";
import { SessionCoordinator } from "../session/session-coordinator.js";
import { VideoManager } from "../video/video-manager.js";

/**
 * Service names for type-safe resolution.
 */
export const Services = {
  Config: "config",
  Metrics: "metrics",
  Token: "token",
  Hooks: "hooks",
  WebHooks: "webhooks",
  Monitoring: "monitoring",
  FileSystem: "fileSystem",
  SessionRegistry: "sessionRegistry",
  SessionCoordinator: "sessionCoordinator",
  VideoManager: "videoManager",
  BrowserManager: "browserManager",
  Limiter: "limiter",
  Router: "router",
} as const;

export type ServiceName = (typeof Services)[keyof typeof Services];

/**
 * Options for creating a container.
 * Any service can be overridden for testing.
 */
export interface ContainerOptions {
  config?: Config;
  metrics?: Metrics;
  token?: Token;
  hooks?: Hooks;
  webhooks?: WebHooks;
  monitoring?: Monitoring;
  fileSystem?: FileSystem;
  sessionRegistry?: SessionRegistry;
  sessionCoordinator?: SessionCoordinator;
  videoManager?: VideoManager;
  browserManager?: BrowserManager;
  limiter?: Limiter;
  router?: Router;
}

/**
 * Create and configure a service container with all Browserless services.
 *
 * Services are registered with their dependencies and can be overridden
 * via the options parameter for testing.
 */
export function createContainer(options: ContainerOptions = {}): ServiceContainer {
  const container = new ServiceContainer();

  // Core configuration - no dependencies
  container.registerSingleton(Services.Config, () => options.config ?? new Config());

  // Metrics - no dependencies
  container.registerSingleton(Services.Metrics, () => options.metrics ?? new Metrics());

  // Token - depends on config
  container.registerSingleton(
    Services.Token,
    (c) => options.token ?? new Token(c.resolve<Config>(Services.Config)),
    [Services.Config],
  );

  // Hooks - no dependencies
  container.registerSingleton(Services.Hooks, () => options.hooks ?? new Hooks());

  // WebHooks - depends on config
  container.registerSingleton(
    Services.WebHooks,
    (c) => options.webhooks ?? new WebHooks(c.resolve<Config>(Services.Config)),
    [Services.Config],
  );

  // Monitoring - depends on config
  container.registerSingleton(
    Services.Monitoring,
    (c) => options.monitoring ?? new Monitoring(c.resolve<Config>(Services.Config)),
    [Services.Config],
  );

  // FileSystem - depends on config
  container.registerSingleton(
    Services.FileSystem,
    (c) => options.fileSystem ?? new FileSystem(c.resolve<Config>(Services.Config)),
    [Services.Config],
  );

  // SessionRegistry - no dependencies (pure data structure)
  container.registerSingleton(
    Services.SessionRegistry,
    () => options.sessionRegistry ?? new SessionRegistry(),
  );

  // VideoManager - no dependencies (video encoding only)
  container.registerSingleton(
    Services.VideoManager,
    () => options.videoManager ?? new VideoManager(),
  );

  // SessionCoordinator - depends on videoManager
  container.registerSingleton(
    Services.SessionCoordinator,
    (c) =>
      options.sessionCoordinator ??
      new SessionCoordinator(c.resolve<VideoManager>(Services.VideoManager)),
    [Services.VideoManager],
  );

  // BrowserManager - depends on config, hooks, fileSystem, videoManager
  container.registerSingleton(
    Services.BrowserManager,
    (c) =>
      options.browserManager ??
      new BrowserManager(
        c.resolve<Config>(Services.Config),
        c.resolve<Hooks>(Services.Hooks),
        c.resolve<FileSystem>(Services.FileSystem),
        c.resolve<VideoManager>(Services.VideoManager),
      ),
    [Services.Config, Services.Hooks, Services.FileSystem, Services.VideoManager],
  );

  // Limiter - depends on config, metrics, monitoring, webhooks, hooks
  container.registerSingleton(
    Services.Limiter,
    (c) =>
      options.limiter ??
      new Limiter(
        c.resolve<Config>(Services.Config),
        c.resolve<Metrics>(Services.Metrics),
        c.resolve<Monitoring>(Services.Monitoring),
        c.resolve<WebHooks>(Services.WebHooks),
        c.resolve<Hooks>(Services.Hooks),
      ),
    [Services.Config, Services.Metrics, Services.Monitoring, Services.WebHooks, Services.Hooks],
  );

  // Router - depends on config, browserManager, limiter
  container.registerSingleton(
    Services.Router,
    (c) =>
      options.router ??
      new Router(
        c.resolve<Config>(Services.Config),
        c.resolve<BrowserManager>(Services.BrowserManager),
        c.resolve<Limiter>(Services.Limiter),
      ),
    [Services.Config, Services.BrowserManager, Services.Limiter],
  );

  return container;
}

/**
 * Create a test container with mocked dependencies.
 * Pass mock implementations for any service you want to replace.
 */
export function createTestContainer(mocks: ContainerOptions = {}): ServiceContainer {
  return createContainer(mocks);
}
