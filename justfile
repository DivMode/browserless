set fallback

# Browserless development commands (deploy via root `just ship`)

default:
    @just --list

build:
    npm run build

build-ext:
    bun extensions/replay/build.js

test:
    npx vitest run

typecheck:
    npx tsc --noEmit

dev port="3000":
    PORT={{port}} npx env-cmd -f .env.dev node --watch build/index.js

watch:
    npx tsc --watch --preserveWatchOutput

dev-setup: build build-ext
    npm run build:function
    npm run install:debugger
