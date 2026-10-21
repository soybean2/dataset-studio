# Dataset Studio

面向 LoRA / 微调训练的数据集图片管理工具：**上传预览 → 自动质检打分 → 近似图过滤 → 本地模型批量打标 → 手动修订 → 导出训练目录**。

后端 Node.js + Fastify + SQLite + sharp，前端 React + Vite，打标由独立的 Python sidecar（WD Tagger / BLIP）完成。单机或局域网自用，无鉴权。

---

## 功能

| 模块 | 说明 |
|------|------|
| 上传预览 | 拖拽 / 文件选择 / 服务器目录批量导入；自动生成缩略图与预览图，秒级刷出网格 |
| 质量评分 | 每张图 0–100 分，由分辨率、清晰度（拉普拉斯方差）、曝光、色彩、噪点五项加权；附中文拒绝理由（模糊 / 过暗 / 过曝 / 短边不足 / 色彩过淡 …） |
| 近似图过滤 | dHash + pHash 双哈希聚类，按阈值自动分组；每组默认保留质量最高的一张，其余标为「近似重复」并排除在导出之外 |
| 自动剔除 | 低于质量阈值或短边不足的图自动进入隔离区（可一键恢复）；隔离区与重复区都不参与导出 |
| 批量打标 | 调用本地 WD Tagger（booru 标签）或 BLIP（自然语言描述），批量并发、进度实时推送 |
| 手动修订 | 单张改 caption / 增删标签（带置信度）；多选后批量加标签、删标签、追加描述、改状态 |
| 手动优先 | 「锁定」和「保留这张」会写入 pinned 标记，重跑去重不会推翻你的选择 |
| 导出 | 输出 `train/NNNN_name.jpg` + 同名 `.txt` 描述 + `metadata.json`，并打包 ZIP；支持追加模式（编号续接、不清空旧文件） |
| 实时反馈 | SSE 事件流推送任务进度、单张分析结果、去重变化，界面无需手动刷新 |

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
cp .env.example .env
mkdir -p data imports

docker compose up -d --build      # 同时启动主服务 + 打标服务
# 或者只启动主服务（不装 torch，界面里打标功能显示"不可用"，其余照常）
docker compose up -d --build api
```

打开 <http://localhost:8787>。

把要处理的图片放进宿主机 `./imports`，在顶栏点「从目录导入」填 `/data/imports` 即可批量导入。

> 首次使用真实模型打标时，sidecar 会从 HuggingFace 下载权重（约 1GB，已挂载 `tagger-models` 卷做缓存）。国内网络可先 `export HF_ENDPOINT=https://hf-mirror.com` 再重建容器。

### 方式二：裸机运行

需要 Node.js ≥ 20、Python ≥ 3.10（打标服务可选）。

```bash
npm install

# 1) 启动打标 sidecar（可选，不启动也能用其它全部功能）
cd tagger
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-ml.txt   # 只联调可省掉 -r requirements-ml.txt
MODE=auto PORT=8790 uvicorn app:app --host 0.0.0.0 --port 8790 &
cd ..

# 2) 开发模式（API 热重载 + Vite 前端 5173，已配置代理）
npm run dev

# 3) 生产模式（前端构建进 web/dist，由 Fastify 一并托管）
npm run build
DATA_DIR=./data PORT=8787 npm start
```

生产模式访问 <http://localhost:8787>；开发模式访问 <http://localhost:5173>。

---

## 使用流程

1. **导入** — 顶栏「上传图片」或直接拖进网格；服务器本地的大批量素材用「从目录导入」。
2. **自动体检** — 导入后自动分析：算质量分、生成缩略图、跑近似图聚类。左侧「状态筛选」按 可用 / 近似重复 / 低质量 / 已排除 分流。
3. **审查近似图** — 「近似图审查」页逐组比对，点「保留这张」改选组长；确认无用的整组「彻底删除重复」。
4. **打标** — 顶栏「批量打标」处理所有未打标图片（含隔离区，避免以后恢复时描述为空）。
5. **修订** — 点单张图打开右侧详情：改 caption、删错标签、补触发词标签。多选用 Ctrl/Shift + 点击，顶部出现批量操作条。
6. **调阈值** — 「设置」页调整最低质量分、最短边、哈希距离，保存后立即对整个数据集重新体检。
7. **导出** — 「导出训练集」页选择输出目录与是否追加，得到 `train/*.jpg + *.txt + metadata.json` 和同名 ZIP。

导出目录结构：

```
dataset-2026-01-01T00-00-00-000Z/
├── train/
│   ├── 0001_char_a.jpg
│   ├── 0001_char_a.txt        # caption（触发词 + 标签 / 手工描述）
│   └── ...
├── metadata.json              # caption, full_path, 原始尺寸, 质量分, 标签
└── ...
dataset-2026-01-01T00-00-00-000Z.zip
```

---

## 配置

所有配置分两层：**环境变量**（部署相关，见 `.env.example`）和**界面设置**（业务阈值，存在 SQLite 里，随时可改）。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（库文件 / 原图 / 缩略图 / 导出） |
| `MAX_UPLOAD_MB` | `40` | 单文件上传上限 |
| `IMPORT_ROOT` | 空 | 目录导入与自定义导出路径的允许前缀，空 = 不限制 |
| `TAGGER_URL` | `http://127.0.0.1:8790` | 打标服务地址（也可在界面设置里改） |

> 服务默认绑 `0.0.0.0` 且**没有任何鉴权**，只应在本机或可信局域网使用。要暴露到公网请自行加反向代理与认证，并务必设置 `IMPORT_ROOT`。

### 界面设置（设置页）

| 项 | 默认 | 说明 |
|----|------|------|
| 最低质量分 | 55 | 低于此分自动移入「低质量」 |
| 最短边像素 | 384 | 宽或高小于此值判为分辨率不足 |
| 近似图哈希距离 | 6 | 感知哈希汉明距离 ≤ 此值判为近似（0 = 完全相同，越大越宽松） |
| 自动隔离 | 开 | 关闭后只标注不剔除，全部保持「可用」 |
| 上传后自动分析 / 自动打标 | 开 / 关 | |
| 打标服务地址 / 模式 | `http://127.0.0.1:8790` / `auto` | `wd` = WD Tagger 标签，`blip` = BLIP 描述，`stub` = 假数据联调 |
| 触发词 | 空 | 会写在每条 caption 最前面 |
| 标签阈值 / 上限 / 批大小 / 并发 | 0.35 / 30 / 4 / 1 | CPU 推理建议并发 1 |
| 导出格式 / JPEG 质量 | jpg / 92 | |

打标 sidecar 自身的环境变量见 [`tagger/README.md`](tagger/README.md)。

---

## HTTP API

所有接口返回 JSON。图片二进制走 `/img/:id/:kind`（`kind` = `thumb` | `preview` | `original`）。

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/health` | 存活、各状态计数、打标服务状态 |
| GET/PUT | `/api/settings` | 读取 / 保存设置（保存后立即重新体检） |
| POST | `/api/upload` | multipart，字段名 `files`（可重复） |
| POST | `/api/import-dir` | `{ path }` 服务器本地目录递归导入 |
| GET | `/api/images` | 列表，支持 `status q tag tagStatus groupId minQuality maxQuality sort page pageSize` |
| GET/PATCH | `/api/images/:id` | 详情 / 修改 `caption tags status pinned` |
| POST | `/api/images/batch` | `{ ids, caption?, appendCaption?, addTags?, removeTags?, status?, tagStatus? }` |
| POST | `/api/images/:id/restore` | 恢复为可用并锁定 |
| DELETE | `/api/images/:id?hard=1` | 软删除（进排除区）/ 彻底删除 |
| POST | `/api/analyze` | `{ ids? }` 重新分析，返回 `jobId` |
| POST | `/api/tag` | `{ ids? }` 批量打标，返回 `jobId` |
| GET | `/api/tagger/health` | 打标服务探活 |
| POST | `/api/dedup/run` | 重新跑近似图聚类与质量剔除 |
| GET | `/api/groups?minSize=2` | 近似图分组 |
| POST | `/api/groups/:groupId/keep` | `{ id }` 改选组长（会锁定） |
| GET | `/api/jobs` `/api/jobs/:id` | 任务列表 / 详情 |
| GET | `/api/stats` | 计数、质量直方图、标签词表 |
| POST | `/api/export` | `{ targetDir?, append? }` 导出训练集 |
| GET | `/api/exports` | 导出历史 |
| GET | `/api/events` | SSE：`job` / `image` / `dedup` / `import` / `export` |

---

## 项目结构

```
server/src/
├── index.ts          Fastify 装配、静态托管、启动时补跑分析
├── config.ts         环境变量 → 目录布局
├── db.ts             SQLite schema、settings、jobs
├── image-engine.ts   解码、哈希、清晰度/亮度/饱和度/噪点、质量评分、缩略图
├── dedup.ts          并查集聚类、组长选举、状态判定
├── pipeline.ts       串行任务队列、导入、分析、恢复、删除
├── tagger.ts         sidecar 客户端、批量打标、caption 拼装
├── export-dataset.ts 训练目录导出与 ZIP
├── repo.ts           查询与 DTO
├── routes.ts         HTTP API
├── events.ts         SSE 事件总线
└── zip.ts            零依赖 ZIP 写入
web/src/
├── App.tsx  main.tsx  store.tsx（全局状态 + SSE）  api.ts（接口封装）  styles.css
└── components/  TopBar / Sidebar / Gallery / ImageGrid / SelectionBar /
                 DetailPanel / DedupPanel / StatsPanel / ExportPanel / SettingsPanel / Toasts
tagger/               Python FastAPI sidecar（WD Tagger / BLIP / stub）
scripts/              test-engine.ts（引擎单测）、test-api.ts（接口端到端）
```

### 质量分怎么算的

`quality = 100 × (0.30·分辨率 + 0.30·清晰度 + 0.15·曝光 + 0.10·色彩 + 0.15·噪点)`，各项归一化到 0–1：

- **分辨率** — 短边相对 1024px 的达标程度
- **清晰度** — 512px 长边灰度图上做 3×3 中值滤波 + 高斯模糊后的拉普拉斯方差
- **曝光** — 平均亮度落在 90–170 区间为满分，两侧衰减
- **色彩** — 平均 HSV 饱和度
- **噪点** — 灰度图与其模糊版本的标准差之差，差值小说明干净

文字理由（`reasons`）由独立规则给出，和分数解耦，所以「62 分但明确写着模糊 + 色彩过淡」是正常现象。分数用于排序和批量剔除，理由用于人工判断。

---

## 测试

```bash
npm test          # 引擎单测 16 项 + 接口端到端 47 项
npm run typecheck # server + web 类型检查
```

`scripts/test-api.ts` 会起一个内存中的 Fastify 实例和一个假打标服务，跑完整链路：上传 → 分析 → 质检剔除 → 近似图分组 → 打标 → 手动改标签 → 改选组长 → 重跑去重 → 导出 → 软/硬删除 → SSE。

---

## 数据与备份

所有东西都在 `DATA_DIR` 一个目录里：

```
data/
├── dataset-studio.db     SQLite（WAL 模式）：图片记录、标签、任务、设置
├── uploads/              原图
├── thumbs/               缩略图与预览图
└── exports/              导出结果与 ZIP
```

备份就是备份这个目录。删掉 `thumbs/` 后点「重新分析」可以重建缩略图；删掉 `.db` 会丢失所有标签和人工修订。
