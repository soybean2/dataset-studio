import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config } from './config.js'
import { getJob, getSettings, listJobs, saveSettings, type ImageStatus, type Settings } from './db.js'
import { publish, subscribe } from './events.js'
import { listGroups, regroup, setGroupKeep } from './dedup.js'
import { deleteImage, importFiles, importFromDirectory, restoreImage, startAnalyze } from './pipeline.js'
import {
  getImage,
  getImageDto,
  imagesByIds,
  listImages,
  qualityHistogram,
  statusCounts,
  tagVocab,
  toDto,
  updateImage,
  uploadPathOf,
  type ListFilter
} from './repo.js'
import { previewPath, thumbPath } from './image-engine.js'
import { pingTagger, startTagging } from './tagger.js'
import { listExports, startExport } from './export-dataset.js'

const STATUSES: ImageStatus[] = ['pending', 'active', 'dup', 'low_quality', 'excluded']
const ID_RE = /^[a-f0-9]{16}$/

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.map(x => String(x).trim()).filter(Boolean)
}

function body(req: { body?: unknown }): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>
}

function isInsideImportRoot(target: string): boolean {
  const root = process.env.IMPORT_ROOT
  if (!root) return true
  const resolved = path.resolve(target)
  const base = path.resolve(root)
  return resolved === base || resolved.startsWith(base + path.sep)
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const settings = getSettings()
    return {
      ok: true,
      version: '0.1.0',
      dataDir: config.dataDir,
      counts: statusCounts(),
      tagger: await pingTagger(settings.taggerUrl, 2500)
    }
  })

  app.get('/api/settings', async () => getSettings())

  app.put('/api/settings', async (req, reply) => {
    const patch: Partial<Settings> = {}
    const b = body(req)
    const numeric: (keyof Settings)[] = [
      'dedupThreshold',
      'minQuality',
      'minEdge',
      'taggerThreshold',
      'taggerMaxTags',
      'taggerBatch',
      'taggerConcurrency',
      'jpgQuality',
      'thumbSize'
    ]
    for (const k of numeric) if (b[k] !== undefined) patch[k] = asNumber(b[k], Number(getSettings()[k])) as never
    for (const k of ['autoQuarantine', 'autoAnalyze', 'autoTag', 'taggerCaption'] as const)
      if (b[k] !== undefined) patch[k] = Boolean(b[k])
    for (const k of ['taggerUrl', 'taggerMode', 'triggerWord'] as const)
      if (typeof b[k] === 'string') patch[k] = String(b[k]).trim() as never
    if (b.outputFormat === 'jpg' || b.outputFormat === 'png') patch.outputFormat = b.outputFormat
    const saved = saveSettings(patch)
    const summary = regroup({
      threshold: saved.dedupThreshold,
      minQuality: saved.minQuality,
      minEdge: saved.minEdge,
      autoQuarantine: saved.autoQuarantine
    })
    return reply.send({ settings: saved, dedup: summary })
  })

  app.post('/api/upload', async req => {
    const files: { name: string; buffer: Buffer }[] = []
    const errors: string[] = []
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue
      const buffer = await part.toBuffer()
      if (part.file.truncated) {
        errors.push(`${part.filename}: 超过 ${config.maxUploadMb}MB 上限`)
        continue
      }
      files.push({ name: part.filename, buffer })
    }
    const summary = await importFiles(files)
    summary.errors.unshift(...errors)
    const settings = getSettings()
    const result: Record<string, unknown> = { ...summary }
    if (settings.autoAnalyze && summary.ids.length) result.jobId = startAnalyze(summary.ids)
    if (settings.autoTag && summary.ids.length) result.tagJobId = startTagging(summary.ids)
    return result
  })

  app.post('/api/import-dir', async req => {
    const dir = String(body(req).path ?? '').trim()
    if (!dir) return { imported: 0, skipped: 0, errors: ['缺少 path'], ids: [] }
    if (!isInsideImportRoot(dir)) return { imported: 0, skipped: 0, errors: [`路径不在 IMPORT_ROOT 允许范围内: ${dir}`], ids: [] }
    const summary = await importFromDirectory(dir)
    const settings = getSettings()
    const result: Record<string, unknown> = { ...summary }
    if (settings.autoAnalyze && summary.ids.length) result.jobId = startAnalyze(summary.ids)
    if (settings.autoTag && summary.ids.length) result.tagJobId = startTagging(summary.ids)
    return result
  })

  app.get('/api/images', async req => {
    const q = req.query as Record<string, string | undefined>
    const filter: ListFilter = {
      status: (q.status as ListFilter['status']) ?? 'all',
      q: q.q?.trim() || undefined,
      tag: q.tag?.trim() || undefined,
      tagStatus: q.tagStatus?.trim() || undefined,
      groupId: q.groupId?.trim() || undefined,
      minQuality: q.minQuality ? asNumber(q.minQuality, NaN) : undefined,
      maxQuality: q.maxQuality ? asNumber(q.maxQuality, NaN) : undefined,
      sort: (q.sort as ListFilter['sort']) ?? 'newest',
      page: asNumber(q.page, 1),
      pageSize: asNumber(q.pageSize, 60)
    }
    const status = filter.status ?? 'all'
    if (status !== 'all' && !STATUSES.includes(status)) filter.status = 'all'
    if (Number.isNaN(filter.minQuality)) filter.minQuality = undefined
    if (Number.isNaN(filter.maxQuality)) filter.maxQuality = undefined
    return listImages(filter)
  })

  app.get('/api/images/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const dto = getImageDto(id)
    return dto ? dto : reply.code(404).send({ error: '图片不存在' })
  })

  app.patch('/api/images/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!getImage(id)) return reply.code(404).send({ error: '图片不存在' })
    const b = body(req)
    const patch: Record<string, unknown> = {}
    if (typeof b.caption === 'string') patch.caption = b.caption
    const tags = asStringArray(b.tags)
    if (tags) patch.tags = JSON.stringify([...new Set(tags)])
    if (typeof b.status === 'string' && STATUSES.includes(b.status as ImageStatus)) {
      patch.status = b.status
      patch.pinned = b.status === 'active' ? 1 : 0
    }
    if (b.pinned !== undefined) patch.pinned = b.pinned ? 1 : 0
    const updated = updateImage(id, patch)
    const dto = updated ? toDto(updated) : undefined
    if (dto) publish('image', dto)
    return dto ?? reply.code(500).send({ error: '更新失败' })
  })

  app.post('/api/images/batch', async req => {
    const b = body(req)
    const ids = asStringArray(b.ids) ?? []
    const rows = imagesByIds(ids)
    const patchBase: Record<string, unknown> = {}
    const addTags = asStringArray(b.addTags)
    const removeTags = new Set(asStringArray(b.removeTags) ?? [])
    if (typeof b.caption === 'string') patchBase.caption = b.caption
    if (typeof b.status === 'string' && STATUSES.includes(b.status as ImageStatus)) {
      patchBase.status = b.status
      patchBase.pinned = b.status === 'active' ? 1 : 0
    }
    let updated = 0
    for (const row of rows) {
      const patch = { ...patchBase }
      const current = JSON.parse(row.tags || '[]') as string[]
      let nextTags: string[] | null = null
      if (removeTags.size) nextTags = current.filter(t => !removeTags.has(t))
      if (addTags?.length) nextTags = [...new Set([...(nextTags ?? current), ...addTags])]
      if (nextTags) patch.tags = JSON.stringify(nextTags)
      if (typeof b.appendCaption === 'string' && b.appendCaption) {
        patch.caption = [row.caption, b.appendCaption].filter(Boolean).join(' ')
      }
      if (typeof b.tagStatus === 'string') patch.tag_status = b.tagStatus
      const result = updateImage(row.id, patch)
      if (result) {
        updated++
        publish('image', toDto(result))
      }
    }
    return { updated, requested: ids.length }
  })

  app.post('/api/images/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string }
    const dto = await restoreImage(id)
    return dto ? dto : reply.code(404).send({ error: '图片不存在' })
  })

  app.delete('/api/images/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const hard = String((req.query as Record<string, string>).hard ?? '') === '1'
    const r = await deleteImage(id, hard)
    return r.ok ? r : reply.code(404).send({ error: '图片不存在' })
  })

  app.post('/api/analyze', async req => {
    const ids = asStringArray(body(req).ids)
    return { jobId: startAnalyze(ids ?? undefined) }
  })

  app.post('/api/tag', async req => {
    const ids = asStringArray(body(req).ids)
    return { jobId: startTagging(ids ?? undefined) }
  })

  app.get('/api/tagger/health', async () => pingTagger(getSettings().taggerUrl))

  app.post('/api/dedup/run', async () => {
    const s = getSettings()
    return regroup({ threshold: s.dedupThreshold, minQuality: s.minQuality, minEdge: s.minEdge, autoQuarantine: s.autoQuarantine })
  })

  app.get('/api/groups', async req => {
    const minSize = asNumber((req.query as Record<string, string>).minSize, 2)
    return { groups: listGroups(Math.max(2, minSize)) }
  })

  app.post('/api/groups/:groupId/keep', async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const keepId = String(body(req).id ?? '')
    if (!keepId) return reply.code(400).send({ error: '缺少 id' })
    try {
      return setGroupKeep(groupId, keepId)
    } catch (e) {
      return reply.code(400).send({ error: String(e) })
    }
  })

  app.get('/api/jobs', async () => ({ jobs: listJobs(30) }))

  app.get('/api/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = getJob(id)
    return job ? job : reply.code(404).send({ error: '任务不存在' })
  })

  app.get('/api/stats', async () => {
    const settings = getSettings()
    return {
      counts: statusCounts(),
      histogram: qualityHistogram(),
      tags: tagVocab(60),
      settings,
      tagger: await pingTagger(settings.taggerUrl, 2500)
    }
  })

  app.post('/api/export', async req => {
    const b = body(req)
    const targetDir = typeof b.targetDir === 'string' && b.targetDir.trim() ? b.targetDir.trim() : null
    if (targetDir && !isInsideImportRoot(targetDir)) return { error: `路径不在 IMPORT_ROOT 允许范围内: ${targetDir}` }
    return startExport(targetDir, Boolean(b.append))
  })

  app.get('/api/exports', async () => ({ exports: listExports() }))

  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    raw.write(': connected\n\n')
    const unsubscribe = subscribe((event, data) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    })
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.get('/img/:id/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string }
    if (!ID_RE.test(id)) return reply.code(400).send({ error: '无效 id' })
    let file: string
    let mime = 'image/jpeg'
    if (kind === 'thumb') file = thumbPath(id)
    else if (kind === 'preview') file = previewPath(id)
    else if (kind === 'original') {
      const row = getImage(id)
      if (!row) return reply.code(404).send({ error: '图片不存在' })
      file = uploadPathOf(row)
      mime = row.mime || 'application/octet-stream'
    } else return reply.code(400).send({ error: '无效类型' })
    const buffer = await fsp.readFile(file).catch(() => null)
    if (!buffer) return reply.code(404).send({ error: '文件不存在' })
    return reply.type(mime).header('Cache-Control', 'public, max-age=86400').send(buffer)
  })
}
