import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import { createJob, getSettings, updateJob } from './db.js'
import { publish } from './events.js'
import { enqueue, sanitizeName } from './pipeline.js'
import { activeImages, uploadPathOf } from './repo.js'
import { zipDirectory } from './zip.js'

export interface ExportResult {
  jobId: string
  outDir: string
}

function nextIndex(trainDir: string): number {
  let max = 0
  try {
    for (const f of fs.readdirSync(trainDir)) {
      const m = /^(\d{4,})_/.exec(f)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    /* 目录不存在则从 1 开始 */
  }
  return max + 1
}

async function writeOutput(srcPath: string, destPath: string, format: 'jpg' | 'png', quality: number): Promise<void> {
  const ext = path.extname(srcPath).toLowerCase()
  if (format === 'jpg' && (ext === '.jpg' || ext === '.jpeg')) {
    await fsp.copyFile(srcPath, destPath)
    return
  }
  const pipeline = sharp(srcPath, { animated: false }).rotate()
  if (format === 'png') await pipeline.png({ compressionLevel: 8 }).toFile(destPath)
  else await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toFile(destPath)
}

export function startExport(targetDir?: string | null, append = false): ExportResult {
  const rows = activeImages()
  const outDir =
    targetDir?.trim() || path.join(config.exportsDir, `dataset-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const job = createJob('export', rows.length)
  publish('job', job)
  enqueue(async () => {
    const settings = getSettings()
    const trainDir = path.join(outDir, 'train')
    if (!append) await fsp.rm(trainDir, { recursive: true, force: true })
    await fsp.mkdir(trainDir, { recursive: true })
    const metaPath = path.join(outDir, 'metadata.json')

    let records: Record<string, unknown>[] = []
    if (append) {
      try {
        const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as unknown
        if (Array.isArray(parsed)) records = parsed
      } catch {
        /* 首次导出 */
      }
    }

    const ext = settings.outputFormat === 'png' ? 'png' : 'jpg'
    let seq = append ? nextIndex(trainDir) : 1
    let done = 0
    let noCaption = 0
    for (const row of rows) {
      const src = uploadPathOf(row)
      const base = `${String(seq++).padStart(4, '0')}_${sanitizeName(path.parse(row.file_name).name)}`
      const fileName = `${base}.${ext}`
      await writeOutput(src, path.join(trainDir, fileName), settings.outputFormat, settings.jpgQuality)
      const caption = row.caption.trim() || JSON.parse(row.tags || '[]').join(', ')
      if (!caption) noCaption++
      await fsp.writeFile(path.join(trainDir, `${base}.txt`), caption, 'utf8')
      records.push({
        caption,
        full_path: `train/${fileName}`,
        dataset: 'train',
        num_repeats: 1,
        source_image: row.file_name,
        original_width: row.width,
        original_height: row.height,
        quality: row.quality,
        tags: JSON.parse(row.tags || '[]')
      })
      done++
      if (done % 10 === 0 || done === rows.length) {
        const j = updateJob(job.id, { done, message: `已导出 ${done}/${rows.length}` })
        if (j) publish('job', j)
      }
      await new Promise(resolve => setImmediate(resolve))
    }

    await fsp.writeFile(metaPath, JSON.stringify(records, null, 2), 'utf8')
    const zipPath = `${outDir.replace(/[\\/]+$/, '')}.zip`
    zipDirectory(outDir, zipPath)
    const finished = updateJob(job.id, {
      status: 'done',
      done: rows.length,
      message: `导出 ${rows.length} 张到 ${outDir}${noCaption ? `（其中 ${noCaption} 张没有描述，建议先打标）` : ''}`,
      finished_at: Date.now()
    })
    if (finished) publish('job', finished)
    publish('export', { outDir, zipPath, count: rows.length })
  })
  return { jobId: job.id, outDir }
}

export function listExports(): { name: string; path: string; zipPath: string | null; mtime: number }[] {
  try {
    return fs
      .readdirSync(config.exportsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const full = path.join(config.exportsDir, e.name)
        const zip = `${full}.zip`
        return {
          name: e.name,
          path: full,
          zipPath: fs.existsSync(zip) ? zip : null,
          mtime: fs.statSync(full).mtimeMs
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}
