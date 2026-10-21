# Dataset Studio —— 主服务
#
# 构建：
#   docker build -t dataset-studio .
# 运行：
#   docker run -d -p 8787:8787 -v $(pwd)/data:/data dataset-studio

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY vite.config.ts ./
COPY server ./server
COPY web ./web
RUN npm run build


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行期只装生产依赖；原生模块（sharp / better-sqlite3）在与运行镜像相同的基座上编译
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

VOLUME /data
EXPOSE 8787

CMD ["node", "dist/index.js"]
