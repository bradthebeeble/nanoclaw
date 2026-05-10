# NanoClaw EE — k8s4claw-adapter container image
#
# Multi-stage build:
#   1. build  — installs all deps (dev + prod) and compiles TypeScript
#   2. runtime — production image; copies only compiled JS + prod node_modules
#
# ENTRYPOINT: node /app/runtimes/k8s4claw-adapter/dist/index.js
# The adapter boots NanoClaw's core, builds the IPC bridge, and starts the
# UDS server at IPC_SOCKET_PATH/runtime.sock (default /var/run/claw/runtime.sock).
#
# Container-in-container note:
#   docker-cli is installed in the runtime stage so NanoClaw's skill-runner can
#   invoke Docker commands against the DinD sidecar socket at /var/run/docker.sock.
#   The docker group (gid 999) matches the DinD socket GID convention used by
#   docker:dind images. USER 1000:999 keeps the process unprivileged while
#   retaining group access to the Docker socket.

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /build

# Enable corepack so pnpm is available without a separate install step.
RUN corepack enable

# Copy package manifests first for layer-cache efficiency.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY runtimes/k8s4claw-adapter/package.json ./runtimes/k8s4claw-adapter/

# Install root workspace dependencies (dev + prod) with frozen lockfile.
# pnpm --frozen-lockfile prevents silent drift in CI and container builds.
RUN pnpm install --frozen-lockfile

# Install adapter dependencies separately — the adapter is a standalone package
# (not a pnpm workspace member) so its deps are not in the root lockfile.
# npm install is used here to get a fresh lock; for reproducible CI builds,
# commit a pnpm-lock.yaml to runtimes/k8s4claw-adapter/ and use --frozen-lockfile.
WORKDIR /build/runtimes/k8s4claw-adapter
RUN npm install --ignore-scripts
WORKDIR /build

# Copy source after deps so source changes don't invalidate the dep layer.
COPY src/ ./src/
COPY tsconfig.json ./
COPY runtimes/k8s4claw-adapter/ ./runtimes/k8s4claw-adapter/

# Compile main host (src/ → dist/).
RUN pnpm exec tsc --project tsconfig.json

# Compile k8s4claw-adapter (runtimes/k8s4claw-adapter/ → runtimes/k8s4claw-adapter/dist/).
# Uses tsconfig.build.json which emits to runtimes/k8s4claw-adapter/dist/.
RUN cd runtimes/k8s4claw-adapter && npx tsc --project tsconfig.build.json

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# docker-cli lets NanoClaw skill-runner invoke Docker commands against the
# DinD sidecar socket (mounted at /var/run/docker.sock in the k8s4claw pod).
RUN apk add --no-cache docker-cli

# Create docker group with gid 999 to match the DinD socket GID convention.
# adduser with uid 1000 and primary group docker (gid 999).
# node:20-alpine ships with: a `ping` group at GID 999, and a `node` user+group at UID/GID 1000.
# Remove both before creating our own — they're not used by the NanoClaw runtime.
# (delgroup/deluser are no-ops if the entity doesn't exist on future alpine bases.)
RUN (deluser node 2>/dev/null || true) && \
    (delgroup node 2>/dev/null || true) && \
    (delgroup ping 2>/dev/null || true) && \
    addgroup -g 999 docker && \
    adduser -D -u 1000 -G docker nanoclaw

WORKDIR /app

# Copy compiled output from build stage.
COPY --from=build /build/dist ./dist
COPY --from=build /build/runtimes/k8s4claw-adapter/dist ./runtimes/k8s4claw-adapter/dist

# Copy production package manifests and lockfiles.
COPY --from=build /build/package.json ./
COPY --from=build /build/pnpm-lock.yaml ./
COPY --from=build /build/pnpm-workspace.yaml ./
COPY --from=build /build/runtimes/k8s4claw-adapter/package.json ./runtimes/k8s4claw-adapter/
COPY --from=build /build/runtimes/k8s4claw-adapter/package-lock.json ./runtimes/k8s4claw-adapter/

# Enable corepack and install production dependencies only.
RUN corepack enable && \
    pnpm install --frozen-lockfile --prod

# Install adapter production dependencies using the lockfile created in the build stage.
WORKDIR /app/runtimes/k8s4claw-adapter
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /app

# Drop to unprivileged user. Group 999 (docker) gives access to the Docker socket.
USER 1000:999

# Socket directory for the IPC bus (k8s4claw mounts this from the sidecar).
# The directory is created as root above before USER switch; nanoclaw has write
# access via group membership or volume mount permissions set by k8s4claw.
ENV IPC_SOCKET_PATH=/var/run/claw

ENTRYPOINT ["node", "/app/runtimes/k8s4claw-adapter/dist/index.js"]
