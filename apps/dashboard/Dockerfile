FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./frontend
COPY src ./src
COPY server.mjs ./
RUN pnpm check && pnpm test && pnpm build

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/dist ./dist
USER app
EXPOSE 8080
CMD ["node", "server.mjs"]
