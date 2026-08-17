FROM denoland/deno:2.5.1

WORKDIR /app
COPY . .
RUN deno cache workers/telemetry-processor/main.ts

USER deno

CMD ["run", "--cached-only", "--allow-env", "--allow-net", "workers/telemetry-processor/main.ts"]
