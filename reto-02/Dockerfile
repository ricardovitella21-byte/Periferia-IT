FROM oven/bun:1.4-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/server.ts"]
