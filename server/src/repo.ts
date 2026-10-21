import path from 'node:path'
import { config } from './config.js'
import { db, type ImageRow, type ImageStatus } from './db.js'

export interface ImageDto {
  id: string
  fileName: string
  status: ImageStatus
  mime: string
  bytes: number
  width: number
  height: number
  quality: number | null
  qualityDetail: Record<string, number> | null
  reasons: string[]
  groupId: string | null
  isGroupKeep: boolean
  pinned: boolean
  caption: string
  tags: string[]
  tagScores: Record<string, number> | null
  tagSource: string | null
  tagStatus: string
  tagError: string | null
  sharpness: number | null
  brightness: number | null
  saturation: number | null
  noise: number | null
  thumbUrl: string
  previewUrl: string
  importedAt: number
  updatedAt: number
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function toDto(row: ImageRow): ImageDto {
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    quality: row.quality,
    qualityDetail: parseJson<Record<string, number> | null>(row.quality_detail, null),
    reasons: parseJson<string[]>(row.reasons, []),
    groupId: row.group_id,
    isGroupKeep: row.is_group_keep === 1,
    pinned: row.pinned === 1,
    caption: row.caption,
    tags: parseJson<string[]>(row.tags, []),
    tagScores: parseJson<Record<string, number> | null>(row.tag_scores, null),
    tagSource: row.tag_source,
    tagStatus: row.tag_status,
    tagError: row.tag_error,
    sharpness: row.sharpness,
    brightness: row.brightness,
    saturation: row.saturation,
    noise: row.noise,
    thumbUrl: `/img/${row.id}/thumb`,
    previewUrl: `/img/${row.id}/preview`,
    importedAt: row.imported_at,
    updatedAt: row.updated_at
  }
}

export function getImage(id: string): ImageRow | undefined {
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined
}

export function getImageDto(id: string): ImageDto | undefined {
  const row = getImage(id)
  return row ? toDto(row) : undefined
}

export function insertImage(row: Omit<ImageRow, 'updated_at'> & { updated_at?: number }): ImageRow {
  const now = row.updated_at ?? Date.now()
  db.prepare(
    `INSERT INTO images (id, file_name, rel_path, mime, bytes, width, height, status, group_id, is_group_keep,
      dhash, phash, sharpness, brightness, saturation, noise, quality, quality_detail, reasons,
      caption, tags, tag_scores, tag_source, tag_status, tag_error, imported_at, updated_at)
     VALUES (@id, @file_name, @rel_path, @mime, @bytes, @width, @height, @status, @group_id, @is_group_keep,
      @dhash, @phash, @sharpness, @brightness, @saturation, @noise, @quality, @quality_detail, @reasons,
      @caption, @tags, @tag_scores, @tag_source, @tag_status, @tag_error, @imported_at, @updated_at)`
  ).run({ ...row, updated_at: now })
  return getImage(row.id)!
}

const UPDATABLE = new Set([
  'file_name',
  'rel_path',
  'mime',
  'bytes',
  'width',
  'height',
  'status',
  'group_id',
  'is_group_keep',
  'pinned',
  'dhash',
  'phash',
  'sharpness',
  'brightness',
  'saturation',
  'noise',
  'quality',
  'quality_detail',
  'reasons',
  'caption',
  'tags',
  'tag_scores',
  'tag_source',
  'tag_status',
  'tag_error'
])

export function updateImage(id: string, patch: Record<string, unknown>): ImageRow | undefined {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE.has(k)) continue
    fields.push(`${k} = ?`)
    values.push(v)
  }
  if (!fields.length) return getImage(id)
  fields.push('updated_at = ?')
  values.push(Date.now(), id)
  db.prepare(`UPDATE images SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getImage(id)
}

export function deleteImageRow(id: string): void {
  db.prepare('DELETE FROM images WHERE id = ?').run(id)
}

export interface ListFilter {
  status?: ImageStatus | 'all'
  q?: string
  tag?: string
  tagStatus?: string
  groupId?: string
  minQuality?: number
  maxQuality?: number
  sort?: 'newest' | 'oldest' | 'quality_desc' | 'quality_asc' | 'name' | 'size_desc'
  page?: number
  pageSize?: number
}

const SORT_SQL: Record<string, string> = {
  newest: 'imported_at DESC',
  oldest: 'imported_at ASC',
  quality_desc: 'quality IS NULL, quality DESC',
  quality_asc: 'quality IS NULL DESC, quality ASC',
  name: 'file_name COLLATE NOCASE ASC',
  size_desc: 'bytes DESC'
}

export function listImages(filter: ListFilter = {}): { items: ImageDto[]; total: number; page: number; pageSize: number } {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status && filter.status !== 'all') {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.groupId) {
    where.push('group_id = ?')
    params.push(filter.groupId)
  }
  if (filter.tagStatus) {
    where.push('tag_status = ?')
    params.push(filter.tagStatus)
  }
  if (filter.q) {
    where.push('(file_name LIKE ? OR caption LIKE ? OR tags LIKE ?)')
    const like = `%${filter.q}%`
    params.push(like, like, like)
  }
  if (filter.tag) {
    where.push('tags LIKE ?')
    params.push(`%"${filter.tag}"%`)
  }
  if (typeof filter.minQuality === 'number') {
    where.push('quality IS NOT NULL AND quality >= ?')
    params.push(filter.minQuality)
  }
  if (typeof filter.maxQuality === 'number') {
    where.push('quality IS NOT NULL AND quality <= ?')
    params.push(filter.maxQuality)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM images ${whereSql}`).get(...params) as { n: number }).n
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 60))
  const order = SORT_SQL[filter.sort ?? 'newest'] ?? SORT_SQL.newest
  const rows = db
    .prepare(`SELECT * FROM images ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as ImageRow[]
  return { items: rows.map(toDto), total, page, pageSize }
}

export function statusCounts(): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM images GROUP BY status').all() as { status: string; n: number }[]
  const out: Record<string, number> = { all: 0, pending: 0, active: 0, dup: 0, low_quality: 0, excluded: 0 }
  for (const r of rows) {
    out[r.status] = r.n
    out.all += r.n
  }
  return out
}

export function tagVocab(limit = 200): { tag: string; count: number }[] {
  const rows = db.prepare("SELECT tags FROM images WHERE tags != '[]'").all() as { tags: string }[]
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const t of parseJson<string[]>(r.tags, [])) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit)
}

export function qualityHistogram(): { bucket: string; count: number }[] {
  const rows = db.prepare('SELECT quality FROM images WHERE quality IS NOT NULL').all() as { quality: number }[]
  const buckets = Array.from({ length: 10 }, () => 0)
  for (const r of rows) buckets[Math.min(9, Math.max(0, Math.floor(r.quality / 10)))]++
  return buckets.map((count, i) => ({ bucket: `${i * 10}-${i * 10 + 9}`, count }))
}

export interface HashRow {
  id: string
  dhash: string
  phash: string
  quality: number
  width: number
  height: number
  status: ImageStatus
  pinned: number
  imported_at: number
}

export function listHashedImages(): HashRow[] {
  return db
    .prepare(
      "SELECT id, dhash, phash, COALESCE(quality, 0) AS quality, width, height, status, pinned, imported_at FROM images WHERE dhash IS NOT NULL AND status != 'excluded'"
    )
    .all() as HashRow[]
}

export function imagesNeedingAnalysis(): ImageRow[] {
  return db
    .prepare("SELECT * FROM images WHERE status != 'excluded' AND (status = 'pending' OR dhash IS NULL) ORDER BY imported_at ASC")
    .all() as ImageRow[]
}

export function uploadPathOf(row: ImageRow): string {
  return path.join(config.uploadsDir, row.rel_path)
}

export function imagesByIds(ids: string[]): ImageRow[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`SELECT * FROM images WHERE id IN (${placeholders})`).all(...ids) as ImageRow[]
}

export function activeImages(): ImageRow[] {
  return db.prepare("SELECT * FROM images WHERE status = 'active' ORDER BY imported_at ASC, file_name ASC").all() as ImageRow[]
}

export function untaggedImages(limit?: number): ImageRow[] {
  // 隔离区的图也可能被手动恢复或改选为保留，一并打标，避免导出时描述为空
  const sql = "SELECT * FROM images WHERE status != 'excluded' AND tag_status != 'tagged' ORDER BY imported_at ASC"
  return (limit ? db.prepare(`${sql} LIMIT ?`).all(limit) : db.prepare(sql).all()) as ImageRow[]
}
