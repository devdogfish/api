FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-script-latn \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
