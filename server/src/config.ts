import fs from 'node:fs'
import path from 'node:path'

export interface Config {
  host: string
  port: number
  dataDir: string
  dbFile: string
  uploadsDir: string
  thumbsDir: string
  exportsDir: string
  webDir: string | null
  maxUploadMb: number
}

function num(v: string | undefined, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

export function loadConfig(cwd = process.cwd()): Config {
  const dataDir = path.resolve(cwd, process.env.DATA_DIR ?? 'data')
  const uploadsDir = path.join(dataDir, 'uploads')
  const thumbsDir = path.join(dataDir, 'thumbs')
  const exportsDir = path.join(dataDir, 'exports')
  for (const d of [dataDir, uploadsDir, thumbsDir, exportsDir]) fs.mkdirSync(d, { recursive: true })
  const webDist = path.resolve(cwd, 'web', 'dist')
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: num(process.env.PORT, 8787),
    dataDir,
    dbFile: path.join(dataDir, 'dataset-studio.db'),
    uploadsDir,
    thumbsDir,
    exportsDir,
    webDir: fs.existsSync(path.join(webDist, 'index.html')) ? webDist : null,
    maxUploadMb: num(process.env.MAX_UPLOAD_MB, 40)
  }
}

export const config = loadConfig()
