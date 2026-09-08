FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

USER root
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble

USER root
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN chown -R pwuser:pwuser /app

USER pwuser
ENTRYPOINT ["node", "dist/cli.js"]
