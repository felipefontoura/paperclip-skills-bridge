FROM node:22-bookworm-slim AS build
WORKDIR /build
# Lockfile is mandatory — build fails (loudly) if it drifts from package.json.
# pnpm-workspace.yaml carries the `onlyBuiltDependencies` allowlist for esbuild
# (consumed at install time on pnpm 11+).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsup.config.ts ./
COPY src ./src
RUN corepack enable \
 && pnpm install --prod=false --frozen-lockfile \
      --config.verify-deps-before-run=false \
      --config.dangerouslyAllowAllBuilds=true \
 && pnpm exec tsup \
 && pnpm prune --prod \
      --config.verify-deps-before-run=false \
      --config.dangerouslyAllowAllBuilds=true

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
# Run as the unprivileged node user that comes with the upstream image.
USER node
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
