FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4010
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts/hash-admin-password.mjs ./scripts/hash-admin-password.mjs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=15s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:4010/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
