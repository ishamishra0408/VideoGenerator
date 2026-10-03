# VideoGenerator in a container: Node 22 runs the TypeScript directly; Chromium films the stage, ffmpeg encodes.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg ca-certificates fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json LICENSE README.md ./
COPY src ./src
COPY stage ./stage
COPY web ./web
COPY examples ./examples

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    CHROME_PATH=/usr/bin/chromium \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

EXPOSE 10000
# The server refuses to start without VIDEOGEN_PASSWORD, because every film spends the OpenRouter key's credit.
CMD ["node", "src/cli.ts", "--serve"]
