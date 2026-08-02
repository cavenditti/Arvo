FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 arvo && useradd --system --uid 10001 --gid arvo arvo
COPY --from=build --chown=arvo:arvo /app/package.json ./package.json
COPY --from=build --chown=arvo:arvo /app/node_modules ./node_modules
COPY --from=build --chown=arvo:arvo /app/dist ./dist
USER arvo
EXPOSE 3000
CMD ["node", "dist/index.js"]
