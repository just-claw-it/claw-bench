# syntax=docker/dockerfile:1
# Multi-stage: TypeScript + Vite dashboard, then slim runtime (Node 20 Alpine; amd64 + arm64).

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm ci --prefix dashboard
COPY dashboard ./dashboard
RUN npm run build --prefix dashboard

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Same default layout as local dev (cwd/clawhub/bench.db → /app/clawhub/bench.db)
ENV CLAW_BENCH_DB=/app/clawhub/bench.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Minimal seed so loadSeedList() works; replace with a bind-mount or run `clawhub crawl` in-container
RUN mkdir -p clawhub && printf '%s\n' '[]' > clawhub/skills-seed.json

EXPOSE 3077
# Mount a named volume or bind at this path in Compose / docker run (see README).

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["dashboard", "--port", "3077"]
