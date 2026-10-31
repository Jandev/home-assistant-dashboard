FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY public ./public
COPY src/assets/house-energy.png ./src/assets/house-energy.png
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data CONFIG_FILE=/app/config/dashboard.json
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node config/dashboard.example.json ./config/dashboard.json
COPY --chown=node:node package.json ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
