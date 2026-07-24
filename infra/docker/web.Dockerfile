FROM node:20-alpine AS build
WORKDIR /srv
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/avatar-schema/package.json packages/avatar-schema/package.json
COPY packages/avatar-runtime/package.json packages/avatar-runtime/package.json
COPY packages/rig-mapping/package.json packages/rig-mapping/package.json
COPY packages/vision-runtime/package.json packages/vision-runtime/package.json
RUN npm ci --no-audit --no-fund
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build --workspace apps/web

FROM node:20-alpine
WORKDIR /srv
RUN npm install -g serve
COPY --from=build /srv/apps/web/dist ./dist
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
