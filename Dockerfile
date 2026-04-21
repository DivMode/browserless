# ---------------------------------------------------------------------------
# browserless-chromium — Dockerfile for Talos k8s (Shipwright buildkit)
#
# The upstream browserless project ships per-browser Dockerfiles under
# docker/{base,chromium,firefox,webkit,edge,multi,sdk,chrome}/ where each
# per-browser file FROMs a shared browserless-base image. That pattern
# assumes the base is available locally on the build daemon (old Flatcar
# flow: `browserless-base:local`) or on a public registry.
#
# Neither works on the Talos cluster. Builds run via Shipwright in buildkit
# Pods that have no access to Flatcar's daemon-local images, and FROM'ing
# the in-cluster Zot (192.168.4.161:5000) would require daemon-level
# insecure-registry config that Shipwright's stock buildkit ClusterBuildStrategy
# doesn't expose (--tls-verify=false on push only, nothing for pull).
#
# This root-level Dockerfile inlines base + chromium into one file so every
# FROM resolves via public registries only. Layer caching through the
# in-cluster registry (--export-cache=type=inline --import-cache=type=registry)
# keeps warm rebuilds fast. Any change under packages/browserless/**
# invalidates buildSourceSha and triggers a rebuild (see
# infra/lib/build-identity.ts).
# ---------------------------------------------------------------------------

FROM ubuntu:24.04

LABEL org.opencontainers.image.source=https://github.com/DivMode/catchseo

ARG DEBIAN_FRONTEND=noninteractive
ARG TZ=America/Los_Angeles
ARG BLESS_USER_ID=999
ARG APP_DIR=/usr/src/app
ARG NODE_VERSION=v24.13.0
ARG NPM_VERSION=11.8.0

ENV NODE_VERSION=$NODE_VERSION
ENV NVM_DIR=/usr/src/.nvm
ENV NODE_PATH=$NVM_DIR/versions/node/$NODE_VERSION/bin
ENV PATH=$NODE_PATH:$PATH
ENV APP_DIR=$APP_DIR
ENV TZ=$TZ
ENV DEBIAN_FRONTEND=$DEBIAN_FRONTEND
ENV HOST=0.0.0.0
ENV PORT=3000
ENV LANG="C.UTF-8"
ENV NODE_ENV=production
ENV DEBUG_COLORS=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/bin/playwright-browsers
ENV DBUS_SESSION_BUS_ADDRESS=autolaunch:

RUN mkdir -p $APP_DIR $NVM_DIR && \
  groupadd -r blessuser && useradd --uid ${BLESS_USER_ID} -r -g blessuser -G audio,video blessuser && \
  mkdir -p /home/blessuser/Downloads && \
  chown -R blessuser:blessuser /home/blessuser

WORKDIR $APP_DIR

COPY fonts/* /usr/share/fonts/truetype/

RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common \
  && add-apt-repository universe \
  && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
  && add-apt-repository multiverse \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  dumb-init \
  git \
  gnupg \
  libu2f-udev \
  ssh \
  unzip \
  wget \
  xvfb \
  xdotool \
  dbus \
  dbus-x11 \
  libwebp-dev \
  python3 python3-pip python3-setuptools \
  fontconfig \
  fonts-freefont-ttf \
  fonts-gfs-neohellenic \
  fonts-indic \
  fonts-ipafont-gothic \
  fonts-kacst \
  fonts-liberation \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  fonts-roboto \
  fonts-thai-tlwg \
  fonts-ubuntu \
  fonts-wqy-zenhei \
  fonts-open-sans \
  && update-alternatives --install /usr/bin/pip pip /usr/bin/pip3 1 \
  && update-alternatives --install /usr/bin/python python /usr/bin/python3 1 \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /usr/share/fonts/truetype/noto

RUN curl -sL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash &&\
  . $NVM_DIR/nvm.sh &&\
  nvm install $NODE_VERSION &&\
  npm install -g npm@$NPM_VERSION

# FFmpeg static binaries via multi-stage copy (pinned, no external wget)
COPY --from=mwader/static-ffmpeg:8.0.1 /ffmpeg /usr/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:8.0.1 /ffprobe /usr/bin/ffprobe

# Bun for build scripts (NOT runtime — see BUN_WEBSOCKET_BUG.md)
RUN curl -fsSL https://bun.com/install | bash && \
  cp /root/.bun/bin/bun /usr/local/bin/bun && \
  chmod +x /usr/local/bin/bun && \
  rm -rf /root/.bun

COPY package.json package-lock.json ./

RUN npm clean-install --ignore-scripts

COPY assets assets
COPY bin bin
COPY extensions extensions
COPY external external
COPY scripts scripts
COPY static static

COPY CHANGELOG.md LICENSE NOTICE.txt README.md tsconfig.json ./

# ---------------------------------------------------------------------------
# chromium layer
# ---------------------------------------------------------------------------

COPY src src/

# NOTE: avoid `npx playwright-core` here — it would pull a newer version than
# the pinned one in package.json. Use the installed CLI directly.
RUN ./node_modules/playwright-core/cli.js install --with-deps chromium && \
  npm run build && \
  npm run build:function && \
  npm prune production && \
  npm run install:debugger && \
  chown -R blessuser:blessuser $APP_DIR && \
  apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY pages pages

USER blessuser

CMD ["./scripts/start.sh"]
