import Database from 'better-sqlite3'
import { config } from './config.js'

export type ImageStatus = 'pending' | 'active' | 'dup' | 'low_quality' | 'excluded'
export type TagStatus = 'pending' | 'tagged' | 'failed'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface ImageRow {
  id: string
  file_name: string
  rel_path: string
  mime: string
  bytes: number
  width: number
  height: number
  status: ImageStatus
  group_id: string | null
  is_group_keep: number
  pinned: number
  dhash: string | null
  phash: string | null
  sharpness: number | null
  brightness: number | null
  saturation: number | null
  noise: number | null
  quality: number | null
  quality_detail: string | null
  reasons: string | null
  caption: string
  tags: string
  tag_scores: string | null
  tag_source: string | null
  tag_status: TagStatus
  tag_error: string | null
  imported_at: number
  updated_at: number
}

export interface JobRow {
  id: string
  kind: string
  status: JobStatus
  total: number
  done: number
  message: string
  error: string | null
  created_at: number
  finished_at: number | null
}

export interface Settings {
  dedupThreshold: number
  minQuality: number
  minEdge: number
  autoQuarantine: boolean
  autoAnalyze: boolean
  autoTag: boolean
  taggerUrl: string
  taggerMode: string
  taggerThreshold: number
  taggerMaxTags: number
  taggerBatch: number
  taggerConcurrency: number
  taggerCaption: boolean
  triggerWord: string
  outputFormat: 'jpg' | 'png'
  jpgQuality: number
  thumbSize: number
}

export const DEFAULT_SETTINGS: Settings = {
  dedupThreshold: 6,
  minQuality: 55,
  minEdge: 384,
  autoQuarantine: true,
  autoAnalyze: true,
  autoTag: false,
  taggerUrl: process.env.TAGGER_URL ?? 'http://127.0.0.1:8790',
  taggerMode: 'auto',
  taggerThreshold: 0.35,
  taggerMaxTags: 30,
  taggerBatch: 4,
  taggerConcurrency: 1,
  taggerCaption: true,
  triggerWord: '',
  outputFormat: 'jpg',
  jpgQuality: 92,
  thumbSize: 384
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  group_id TEXT,
  is_group_keep INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  dhash TEXT,
  phash TEXT,
  sharpness REAL,
  brightness REAL,
  saturation REAL,
  noise REAL,
  quality INTEGER,
  quality_detail TEXT,
  reasons TEXT,
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  tag_scores TEXT,
  tag_source TEXT,
  tag_status TEXT NOT NULL DEFAULT 'pending',
  tag_error TEXT,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_group ON images(group_id);
CREATE INDEX IF NOT EXISTS idx_images_quality ON images(quality);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export const db = new Database(config.dbFile)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.exec(SCHEMA)

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out = { ...DEFAULT_SETTINGS }
  for (const r of rows) {
    if (!(r.key in out)) continue
    try {
      const parsed = JSON.parse(r.value) as unknown
      const key = r.key as keyof Settings
      ;(out as Record<string, unknown>)[key] = parsed
    } catch {
      /* 忽略损坏的设置项 */
    }
  }
  return out
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const next = { ...current, ...patch }
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) stmt.run(k, v)
  })
  tx(Object.entries(next).map(([k, v]) => [k, JSON.stringify(v)] as [string, string]))
  return next
}

export function createJob(kind: string, total: number): JobRow {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  db.prepare(
    'INSERT INTO jobs (id, kind, status, total, done, message, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(id, kind, 'running', total, '', now)
  return { id, kind, status: 'running', total, done: 0, message: '', error: null, created_at: now, finished_at: null }
}

export function updateJob(id: string, patch: Partial<Pick<JobRow, 'status' | 'done' | 'message' | 'error' | 'finished_at'>>): JobRow | undefined {
  const fields: string[] = []
  const values: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    fields.push(`${k} = ?`)
    values.push(v)
  }
  if (!fields.length) return getJob(id)
  values.push(id)
  db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return getJob(id)
}

export function getJob(id: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
}

export function listJobs(limit = 20): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[]
}

export function closeDb(): void {
  if (db.open) db.close()
}
