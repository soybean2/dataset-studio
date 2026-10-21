import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.js'
import { createJob, getSettings, updateJob, type ImageRow, type Settings } from './db.js'
import { analyzeImage, isImageFile, qualityReasons, removeThumbs, writeThumbs } from './image-engine.js'
import { getImage, getImageDto, imagesByIds, imagesNeedingAnalysis, insertImage, toDto, updateImage, uploadPathOf } from './repo.js'
import { publish } from './events.js'
import { regroup } from './dedup.js'

export interface ImportSummary {
  imported: number
  skipped: number
  errors: string[]
  ids: string[]
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif'
}

export function sanitizeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'image'
}

type Task = () => Promise<void>
const queue: Task[] = []
let draining = false

export function enqueue(task: Task): void {
  queue.push(task)
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const task = queue.shift()!
      try {
        await task()
      } catch (e) {
        console.error('[job] 任务失败', e)
      }
    }
  } finally {
    draining = false
  }
}

export function queueDepth(): number {
  return queue.length
}

export async function importBuffer(buffer: Buffer, fileName: string): Promise<{ id: string | null; skipped: boolean; error?: string }> {
  const clean = sanitizeName(path.basename(fileName))
  if (!isImageFile(clean)) return { id: null, skipped: true, error: `不支持的格式: ${clean}` }
  if (buffer.length > config.maxUploadMb * 1024 * 1024) return { id: null, skipped: true, error: `文件过大: ${clean}` }
  const id = createHash('sha1').update(buffer).digest('hex').slice(0, 16)
  if (getImage(id)) return { id, skipped: true }
  const ext = path.extname(clean).toLowerCase()
  const relPath = `${id}${ext}`
  await fsp.writeFile(path.join(config.uploadsDir, relPath), buffer)
  const row = insertImage({
    id,
    file_name: clean,
    rel_path: relPath,
    mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
    bytes: buffer.length,
    width: 0,
    height: 0,
    status: 'pending',
    group_id: null,
    is_group_keep: 0,
    pinned: 0,
    dhash: null,
    phash: null,
    sharpness: null,
    brightness: null,
    saturation: null,
    noise: null,
    quality: null,
    quality_detail: null,
    reasons: null,
    caption: '',
    tags: '[]',
    tag_scores: null,
    tag_source: null,
    tag_status: 'pending',
    tag_error: null,
    imported_at: Date.now()
  })
  publish('image', toDto(row))
  return { id, skipped: false }
}

export async function importFiles(files: { name: string; buffer: Buffer }[]): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skipped: 0, errors: [], ids: [] }
  for (const f of files) {
    try {
      const r = await importBuffer(f.buffer, f.name)
      if (r.error) summary.errors.push(r.error)
      else if (r.skipped) summary.skipped++
      else if (r.id) {
        summary.imported++
        summary.ids.push(r.id)
      }
    } catch (e) {
      summary.errors.push(`${f.name}: ${String(e)}`)
    }
  }
  publish('import', summary)
  return summary
}

export async function walkImageFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && isImageFile(e.name)) out.push(full)
    }
  }
  return out.sort()
}

export async function importFromDirectory(dir: string): Promise<ImportSummary> {
  const stat = await fsp.stat(dir).catch(() => null)
  if (!stat) return { imported: 0, skipped: 0, errors: [`目录不存在: ${dir}`], ids: [] }
  const files = stat.isDirectory() ? await walkImageFiles(dir) : isImageFile(dir) ? [dir] : []
  const payload: { name: string; buffer: Buffer }[] = []
  const errors: string[] = []
  for (const f of files) {
    try {
      const s = await fsp.stat(f)
      if (s.size > config.maxUploadMb * 1024 * 1024) {
        errors.push(`跳过过大文件: ${path.basename(f)}`)
        continue
      }
      payload.push({ name: path.basename(f), buffer: await fsp.readFile(f) })
    } catch (e) {
      errors.push(`${path.basename(f)}: ${String(e)}`)
    }
  }
  const summary = await importFiles(payload)
  summary.errors.unshift(...errors)
  return summary
}

export async function analyzeOne(row: ImageRow, settings: Settings): Promise<void> {
  const full = uploadPathOf(row)
  const buffer = await fsp.readFile(full)
  const res = await analyzeImage(buffer)
  await writeThumbs(row.id, buffer, settings.thumbSize)
  const reasons = qualityReasons({
    width: res.width,
    height: res.height,
    sharpness: res.sharpness,
    brightness: res.brightness,
    saturation: res.saturation,
    noise: res.noise,
    minEdge: settings.minEdge
  })
  if (res.quality < settings.minQuality && !reasons.length) reasons.push(`质量分 ${res.quality} < ${settings.minQuality}`)
  const lowQuality = reasons.length > 0
  const status = row.pinned
    ? row.status === 'pending'
      ? 'active'
      : row.status
    : lowQuality && settings.autoQuarantine
      ? 'low_quality'
      : 'active'
  const updated = updateImage(row.id, {
    width: res.width,
    height: res.height,
    mime: MIME_BY_EXT[path.extname(row.file_name).toLowerCase()] ?? row.mime,
    dhash: res.dhash,
    phash: res.phash,
    sharpness: res.sharpness,
    brightness: res.brightness,
    saturation: res.saturation,
    noise: res.noise,
    quality: res.quality,
    quality_detail: JSON.stringify(res.qualityDetail),
    reasons: JSON.stringify(reasons),
    status
  })
  if (updated) publish('image', toDto(updated))
}

export function startAnalyze(ids?: string[]): string {
  const rows = ids?.length ? imagesByIds(ids).filter(r => r.status !== 'excluded') : imagesNeedingAnalysis()
  const job = createJob('analyze', rows.length)
  publish('job', job)
  enqueue(async () => {
    const settings = getSettings()
    let done = 0
    let failed = 0
    for (const row of rows) {
      try {
        await analyzeOne(row, settings)
      } catch (e) {
        failed++
        const marked = updateImage(row.id, { reasons: JSON.stringify([`分析失败: ${String(e)}`]) })
        if (marked) publish('image', toDto(marked))
      }
      done++
      if (done % 5 === 0 || done === rows.length) {
        const j = updateJob(job.id, { done, message: `已分析 ${done}/${rows.length}` })
        if (j) publish('job', j)
      }
      await new Promise(resolve => setImmediate(resolve))
    }
    const dedup = regroup({
      threshold: settings.dedupThreshold,
      minQuality: settings.minQuality,
      minEdge: settings.minEdge,
      autoQuarantine: settings.autoQuarantine
    })
    const finished = updateJob(job.id, {
      status: 'done',
      done: rows.length,
      message: `分析 ${dedup.scanned} 张：近似组 ${dedup.groups}，重复剔除 ${dedup.duplicates}，低质隔离 ${dedup.lowQuality}`,
      error: failed ? `${failed} 张分析失败` : null,
      finished_at: Date.now()
    })
    if (finished) publish('job', finished)
    publish('dedup', dedup)
  })
  return job.id
}

export async function restoreImage(id: string): Promise<ReturnType<typeof getImageDto>> {
  const row = getImage(id)
  if (!row) return undefined
  const updated = updateImage(id, { pinned: 1, status: 'active', tag_error: null })
  const dto = updated ? toDto(updated) : undefined
  if (dto) publish('image', dto)
  return dto
}

export async function deleteImage(id: string, hard: boolean): Promise<{ ok: boolean; hard: boolean }> {
  const row = getImage(id)
  if (!row) return { ok: false, hard }
  if (hard) {
    await fsp.rm(uploadPathOf(row), { force: true })
    await removeThumbs(id)
    const { deleteImageRow } = await import('./repo.js')
    deleteImageRow(id)
  } else {
    const updated = updateImage(id, { status: 'excluded', pinned: 0 })
    if (updated) publish('image', toDto(updated))
  }
  publish('delete', { id, hard })
  return { ok: true, hard }
}
