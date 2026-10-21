export type ImageStatus = 'pending' | 'active' | 'dup' | 'low_quality' | 'excluded'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

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

export interface JobDto {
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

export interface TaggerHealth {
  ok: boolean
  mode?: string
  model?: string
  device?: string
  ready?: boolean
  loaded?: boolean
  error?: string
}

export interface ListResult {
  items: ImageDto[]
  total: number
  page: number
  pageSize: number
}

export interface GroupView {
  groupId: string
  size: number
  keepId: string | null
  images: ImageDto[]
}

export interface Stats {
  counts: Record<string, number>
  histogram: { bucket: string; count: number }[]
  tags: { tag: string; count: number }[]
  settings: Settings
  tagger: TaggerHealth
}

export interface ListQuery {
  status?: ImageStatus | 'all'
  q?: string
  tag?: string
  tagStatus?: string
  groupId?: string
  minQuality?: number
  maxQuality?: number
  sort?: string
  page?: number
  pageSize?: number
}

export interface BatchPatch {
  ids: string[]
  caption?: string
  appendCaption?: string
  addTags?: string[]
  removeTags?: string[]
  status?: ImageStatus
  tagStatus?: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(payload)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) throw new ApiError(String(data.error ?? `HTTP ${res.status}`), res.status)
  return data as T
}

export const api = {
  health: () => request<{ ok: boolean; version: string; dataDir: string; counts: Record<string, number>; tagger: TaggerHealth }>('GET', '/api/health'),
  getSettings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<{ settings: Settings; dedup: DedupSummary }>('PUT', '/api/settings', patch),

  upload: (files: File[], onProgress?: (ratio: number) => void) =>
    new Promise<ImportResult>((resolve, reject) => {
      const form = new FormData()
      for (const f of files) form.append('files', f, f.name)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/upload')
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText) as ImportResult & { error?: string }
          if (xhr.status >= 400) reject(new ApiError(String(data.error ?? `HTTP ${xhr.status}`), xhr.status))
          else resolve(data)
        } catch (e) {
          reject(new ApiError(`上传响应解析失败: ${String(e)}`, xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiError('上传失败（网络错误）', 0))
      xhr.send(form)
    }),

  importDir: (path: string) => request<ImportResult>('POST', '/api/import-dir', { path }),

  listImages: (query: ListQuery) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v))
    return request<ListResult>('GET', `/api/images?${params.toString()}`)
  },
  getImage: (id: string) => request<ImageDto>('GET', `/api/images/${id}`),
  patchImage: (id: string, patch: Partial<Pick<ImageDto, 'caption' | 'tags' | 'status' | 'pinned'>>) => request<ImageDto>('PATCH', `/api/images/${id}`, patch),
  batch: (patch: BatchPatch) => request<{ updated: number; requested: number }>('POST', '/api/images/batch', patch),
  restore: (id: string) => request<ImageDto>('POST', `/api/images/${id}/restore`),
  remove: (id: string, hard: boolean) => request<{ ok: boolean; hard: boolean }>('DELETE', `/api/images/${id}${hard ? '?hard=1' : ''}`),

  analyze: (ids?: string[]) => request<{ jobId: string }>('POST', '/api/analyze', { ids }),
  tag: (ids?: string[]) => request<{ jobId: string }>('POST', '/api/tag', { ids }),
  taggerHealth: () => request<TaggerHealth>('GET', '/api/tagger/health'),
  runDedup: () => request<DedupSummary>('POST', '/api/dedup/run', {}),
  groups: (minSize = 2) => request<{ groups: GroupView[] }>('GET', `/api/groups?minSize=${minSize}`),
  setKeep: (groupId: string, id: string) => request<{ updated: number; groupId: string }>('POST', `/api/groups/${groupId}/keep`, { id }),

  jobs: () => request<{ jobs: JobDto[] }>('GET', '/api/jobs'),
  job: (id: string) => request<JobDto>('GET', `/api/jobs/${id}`),
  stats: () => request<Stats>('GET', '/api/stats'),
  export: (targetDir: string, append: boolean) => request<{ jobId: string; outDir: string; error?: string }>('POST', '/api/export', { targetDir, append }),
  exports: () => request<{ exports: { name: string; path: string; zipPath: string | null; mtime: number }[] }>('GET', '/api/exports')
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
  ids: string[]
  jobId?: string
  tagJobId?: string
}

export interface DedupSummary {
  scanned: number
  groups: number
  duplicates: number
  lowQuality: number
  changed: number
}

export const STATUS_LABEL: Record<ImageStatus | 'all', string> = {
  all: '全部',
  pending: '待处理',
  active: '可用',
  dup: '近似重复',
  low_quality: '低质量',
  excluded: '已排除'
}

export const THUMB_QUALITY_COLOR = (q: number | null): string => {
  if (q === null) return 'var(--muted)'
  if (q >= 80) return 'var(--good)'
  if (q >= 60) return 'var(--warn)'
  return 'var(--bad)'
}
