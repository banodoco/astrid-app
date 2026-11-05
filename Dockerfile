# Pinned to satisfy package-lock.json's ^20.19.0 || >=22.12.0 engine constraint.
# Bumping the FROM tag is the ONLY Node-version authority for production —
# .nvmrc and engines.node must track this value.
FROM node:20.19.4-alpine@sha256:df02558528d3d3d0d621f112e232611aecfee7cbc654f6b375765f72bb262799 AS build
WORKDIR /app

# vendor/ is copied with package*.json because devDependency fake-indexeddb
# is "file:vendor/fake-indexeddb" — npm ci needs it present at install time.
COPY package.json package-lock.json ./
COPY vendor ./vendor
# package.json's postinstall runs scripts/patches/remotion-*.mjs during npm ci.
COPY scripts/patches ./scripts/patches
# The base image's bundled npm 10.8.2 crashes while validating this lockfile
# ("Cannot read properties of null (reading 'edgesOut')" in its peer-set
# resolver), so every image build failed at this step. npm 11 installs the
# same lockfile cleanly; only the install tool changes, not the Node runtime.
RUN npm install -g npm@11.21.1 --no-audit --no-fund && npm ci --no-audit --no-fund

COPY . .

# Vite inlines ordinary browser client config into the JS bundle.
# The hosted editor reaches each visitor’s existing Runtime through the local
# authenticated gateway. The same app serves the public site and all tool routes.
# Runtime credentials stay outside the image; visitor identity binds at connection.
ARG VITE_API_TARGET_URL
RUN node scripts/build/verify-astrid-vendor-sources.mjs && \
    VITE_API_TARGET_URL="$VITE_API_TARGET_URL" \
    VITE_RUNTIME_ORIGIN="http://127.0.0.1:17340" \
    VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID="" \
    VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID="" \
    VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID="" \
    NODE_OPTIONS="--max-old-space-size=4096" npm run build

FROM node:20.19.4-alpine@sha256:df02558528d3d3d0d621f112e232611aecfee7cbc654f6b375765f72bb262799 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
LABEL org.opencontainers.image.base.digest="sha256:df02558528d3d3d0d621f112e232611aecfee7cbc654f6b375765f72bb262799"

# `npm run serve` is `vite preview`, which loads config/vite/vite.config.ts
# at runtime. That config imports @vitejs/plugin-react-swc (a devDependency),
# so we need the full install — copying node_modules from the build stage
# is simpler and more reliable than reinstalling with pinned versions here.
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --chown=node:node config ./config
# `vite preview` loads config/vite/vite.config.ts at startup, and that config
# imports from src/ (bridge protocol, Runtime client, share copy) and checks
# for the bundled Astrid browser source in vendor/. Hand-picking single files
# broke every time the config's import graph grew (the preview then failed to
# start and the Railway healthcheck never passed), so ship src/ and vendor/
# whole; vendor/ also keeps node_modules' file: links valid.
COPY --chown=node:node src ./src
COPY --chown=node:node vendor ./vendor
# config/vite/*.ts imports ../../scripts/*.mjs (local-update-control, runtime-discovery-proxy)
# and reads public/install-manifest.json at preview startup; without them `vite preview`
# exits with ERR_MODULE_NOT_FOUND and the Railway healthcheck never passes.
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public/install-manifest.json ./public/install-manifest.json
COPY --chown=node:node --from=build /app/dist ./dist

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error(String(r.status))})"
USER node
CMD ["npm", "run", "serve"]
