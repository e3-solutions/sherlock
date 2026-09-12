FROM denoland/deno:2.5.1

WORKDIR /app
COPY . .
RUN deno cache --config workers/telemetry-processor/deno.json \
    workers/telemetry-processor/main.ts

USER deno

CMD ["run", "--config", "workers/telemetry-processor/deno.json", "--cached-only", "--allow-env", "--allow-net", "workers/telemetry-processor/main.ts"]
