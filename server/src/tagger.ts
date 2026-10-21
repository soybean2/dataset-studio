import fsp from 'node:fs/promises'
import { createJob, getSettings, updateJob, type ImageRow, type Settings } from './db.js'
import { publish } from './events.js'
import { enqueue } from './pipeline.js'
import { imagesByIds, toDto, untaggedImages, updateImage, uploadPathOf } from './repo.js'

export interface TaggerHealth {
  ok: boolean
  mode?: string
  model?: string
  device?: string
  ready?: boolean
  loaded?: boolean
  error?: string
}

export interface TagResult {
  id: string
  tags: string[]
  scores: Record<string, number>
  caption: string
  error?: string
}

export async function pingTagger(url: string, timeoutMs = 5000): Promise<TaggerHealth> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = (await res.json()) as Record<string, unknown>
    return {
      ok: data.status === 'ok',
      mode: String(data.mode ?? ''),
      model: String(data.model ?? ''),
      device: String(data.device ?? ''),
      ready: Boolean(data.ready),
      loaded: Boolean(data.loaded)
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

async function tagBatch(
  files: { id: string; buffer: Buffer }[],
  settings: Settings
): Promise<TagResult[]> {
  const form = new FormData()
  form.append('threshold', String(settings.taggerThreshold))
  form.append('max_tags', String(settings.taggerMaxTags))
  form.append('caption', settings.taggerCaption ? '1' : '0')
  if (settings.taggerMode && settings.taggerMode !== 'auto') form.append('mode', settings.taggerMode)
  for (const f of files) form.append('files', new Blob([new Uint8Array(f.buffer)]), `${f.id}.img`)

  const res = await fetch(`${settings.taggerUrl.replace(/\/$/, '')}/tag`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(600_000)
  })
  if (!res.ok) throw new Error(`打标服务返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { results?: { id: string; tags?: { name: string; score: number }[]; caption?: string; error?: string | null }[] }
  const byId = new Map<string, TagResult>()
  for (const r of data.results ?? []) {
    const tags = (r.tags ?? []).map(t => t.name)
    const scores: Record<string, number> = {}
    for (const t of r.tags ?? []) scores[t.name] = Number(t.score.toFixed(4))
    byId.set(r.id, { id: r.id, tags, scores, caption: r.caption ?? '', error: r.error ?? undefined })
  }
  return files.map(f => byId.get(f.id) ?? { id: f.id, tags: [], scores: {}, caption: '', error: '打标服务未返回该图片结果' })
}

function composeCaption(raw: string, tags: string[], triggerWord: string): string {
  const body = raw.trim() || tags.join(', ')
  const prefix = triggerWord.trim()
  if (!prefix) return body
  return body.startsWith(prefix) ? body : `${prefix}, ${body}`
}

export function startTagging(ids?: string[]): string {
  const settings = getSettings()
  const rows = (ids?.length ? imagesByIds(ids) : untaggedImages()).filter(r => r.status !== 'excluded')
  const job = createJob('tag', rows.length)
  publish('job', job)
  enqueue(async () => {
    const health = await pingTagger(settings.taggerUrl)
    if (!health.ok) {
      const message = `无法连接打标服务 ${settings.taggerUrl}: ${health.error ?? '未知错误'}`
      const failed = updateJob(job.id, { status: 'failed', message, error: message, finished_at: Date.now() })
      if (failed) publish('job', failed)
      return
    }
    const source = health.model || health.mode || 'tagger'
    const batchSize = Math.max(1, settings.taggerBatch)
    const concurrency = Math.max(1, settings.taggerConcurrency)
    const batches: ImageRow[][] = []
    for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))

    let done = 0
    let failed = 0
    let cursor = 0
    const nextBatch = (): ImageRow[] | null => (cursor < batches.length ? batches[cursor++] : null)

    const worker = async (): Promise<void> => {
      for (;;) {
        const batch = nextBatch()
        if (!batch) return
        const files: { id: string; buffer: Buffer }[] = []
        for (const row of batch) {
          try {
            files.push({ id: row.id, buffer: await fsp.readFile(uploadPathOf(row)) })
          } catch (e) {
            const marked = updateImage(row.id, { tag_status: 'failed', tag_error: `读取失败: ${String(e)}` })
            if (marked) publish('image', toDto(marked))
            failed++
          }
        }
        if (files.length) {
          try {
            const results = await tagBatch(files, settings)
            for (const r of results) {
              const patch: Record<string, unknown> = r.error
                ? { tag_status: 'failed', tag_error: r.error }
                : {
                    tag_status: 'tagged',
                    tag_error: null,
                    tags: JSON.stringify(r.tags),
                    tag_scores: JSON.stringify(r.scores),
                    caption: composeCaption(r.caption, r.tags, settings.triggerWord),
                    tag_source: source
                  }
              const updated = updateImage(r.id, patch)
              if (updated) publish('image', toDto(updated))
              if (r.error) failed++
            }
          } catch (e) {
            failed += files.length
            for (const f of files) {
              const updated = updateImage(f.id, { tag_status: 'failed', tag_error: String(e) })
              if (updated) publish('image', toDto(updated))
            }
          }
        }
        done += batch.length
        const j = updateJob(job.id, { done, message: `已打标 ${done}/${rows.length}` })
        if (j) publish('job', j)
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length || 1) }, worker))
    const finished = updateJob(job.id, {
      status: failed && failed >= rows.length ? 'failed' : 'done',
      done: rows.length,
      message: `打标完成 ${rows.length - failed}/${rows.length}`,
      error: failed ? `${failed} 张打标失败` : null,
      finished_at: Date.now()
    })
    if (finished) publish('job', finished)
  })
  return job.id
}
