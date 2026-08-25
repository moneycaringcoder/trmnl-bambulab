# Node 22.18 is the first release covered by the package's engine constraint.
# The digest pins the official multi-platform image rather than one architecture.
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS dependencies

# Corepack is included with Node 22. Invoke an exact pnpm version below, so both
# the installer and the frozen lockfile determine what enters the image.
RUN corepack enable
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node

COPY --chown=node:node collector/package.json collector/pnpm-lock.yaml ./
RUN corepack pnpm@11.13.1 install --prod --frozen-lockfile

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

ENV NODE_ENV=production

RUN mkdir /app && chown node:node /app
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules

# The collector deliberately reuses these modules from source. Their package
# files keep Node's ESM rules in force; no compiler or dist directory is needed.
COPY --chown=node:node bridge/package.json ./bridge/package.json
COPY --chown=node:node bridge/src ./bridge/src
COPY --chown=node:node hosted/package.json ./hosted/package.json
COPY --chown=node:node hosted/src ./hosted/src
COPY --chown=node:node collector/package.json ./collector/package.json
COPY --chown=node:node collector/src ./collector/src

WORKDIR /app/collector
USER node

# Runtime state is only in Neon and logs go to stdout and stderr. No writable
# directory is required, so the image runs with a read-only root
# filesystem. Secrets belong in the runtime environment, never in this image.
# Nothing connects inward, so there is deliberately no EXPOSE instruction.
CMD ["node", "src/index.ts"]
