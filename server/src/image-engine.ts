import path from 'node:path'
import fsp from 'node:fs/promises'
import sharp from 'sharp'
import { config } from './config.js'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.gif'])

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase())
}

export function makeId(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0
    h2 = Math.imul(h2 + seed.charCodeAt(i) + i, 2654435761) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export interface QualityDetail {
  resolution: number
  sharpness: number
  exposure: number
  color: number
  noise: number
}

export interface AnalyzeResult {
  width: number
  height: number
  format: string
  dhash: string
  phash: string
  sharpness: number
  brightness: number
  saturation: number
  noise: number
  quality: number
  qualityDetail: QualityDetail
  reasons: string[]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function scoreResolution(width: number, height: number): number {
  const short = Math.min(width, height)
  return clamp01((short - 256) / (768 - 256))
}

export function scoreSharpness(lapVar: number): number {
  return clamp01(Math.log10(1 + Math.max(0, lapVar)) / Math.log10(1 + 120))
}

export function scoreExposure(brightness: number): number {
  if (brightness < 15 || brightness > 245) return 0
  return clamp01(1 - (Math.abs(brightness - 128) / 128) * 1.7)
}

export function scoreColor(saturation: number): number {
  if (saturation > 0.9) return 0.35
  return clamp01(saturation / 0.1) * 0.85 + 0.15
}

export function scoreNoise(noiseStd: number): number {
  return clamp01(1 - (noiseStd - 2.5) / 20)
}

export function computeQuality(input: {
  width: number
  height: number
  sharpness: number
  brightness: number
  saturation: number
  noise: number
}): { quality: number; detail: QualityDetail } {
  const detail: QualityDetail = {
    resolution: scoreResolution(input.width, input.height),
    sharpness: scoreSharpness(input.sharpness),
    exposure: scoreExposure(input.brightness),
    color: scoreColor(input.saturation),
    noise: scoreNoise(input.noise)
  }
  const weighted =
    detail.resolution * 0.3 + detail.sharpness * 0.3 + detail.exposure * 0.15 + detail.color * 0.1 + detail.noise * 0.15
  return { quality: Math.round(weighted * 100), detail }
}

export function qualityReasons(r: {
  width: number
  height: number
  sharpness: number
  brightness: number
  saturation: number
  noise: number
  minEdge: number
}): string[] {
  const reasons: string[] = []
  const short = Math.min(r.width, r.height)
  if (short < r.minEdge) reasons.push(`短边 ${short}px < ${r.minEdge}px`)
  if (r.sharpness < 8) reasons.push(`模糊 (清晰度 ${r.sharpness.toFixed(1)})`)
  if (r.brightness < 30) reasons.push(`过暗 (亮度 ${r.brightness.toFixed(0)})`)
  if (r.brightness > 225) reasons.push(`过亮 (亮度 ${r.brightness.toFixed(0)})`)
  if (r.saturation < 0.03) reasons.push(`色彩过淡 (饱和度 ${r.saturation.toFixed(3)})`)
  if (r.noise > 22) reasons.push(`噪点过高 (${r.noise.toFixed(1)})`)
  return reasons
}

function laplacianVariance(buf: Buffer, w: number, h: number): number {
  if (w < 3 || h < 3 || buf.length < w * h) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = 4 * buf[i] - buf[i - 1] - buf[i + 1] - buf[i - w] - buf[i + w]
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (!n) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

function diffStd(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    sum += d
    sumSq += d * d
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean))
}

export function hammingHex(a: string, b: string): number {
  const len = Math.min(a.length, b.length)
  let c = 0
  for (let i = 0; i < len; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      c += x & 1
      x >>= 1
    }
  }
  return c
}

export function hashDistance(a: { dhash: string; phash: string }, b: { dhash: string; phash: string }): number {
  return Math.min(hammingHex(a.dhash, b.dhash), hammingHex(a.phash, b.phash))
}

export async function analyzeImage(input: Buffer | string): Promise<AnalyzeResult> {
  const base = sharp(input, { animated: false })
  const meta = await base.metadata()
  const orientation = meta.orientation ?? 1
  const rotated = orientation >= 5 && orientation <= 8
  const width = (rotated ? meta.height : meta.width) ?? 0
  const height = (rotated ? meta.width : meta.height) ?? 0
  if (!width || !height) throw new Error('无法读取图片尺寸')

  const dh = await base.clone().rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
  let dhBits = 0n
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (dh[row * 9 + col] < dh[row * 9 + col + 1]) dhBits |= 1n << BigInt(row * 8 + col)
    }
  }
  const dhash = dhBits.toString(16).padStart(16, '0')

  const g32 = await base.clone().rotate().grayscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer()
  let gSum = 0
  for (const v of g32) gSum += v
  const gMean = gSum / g32.length
  let phash = ''
  for (let i = 0; i < g32.length; i += 4) {
    const nib =
      (g32[i] >= gMean ? 8 : 0) + (g32[i + 1] >= gMean ? 4 : 0) + (g32[i + 2] >= gMean ? 2 : 0) + (g32[i + 3] >= gMean ? 1 : 0)
    phash += nib.toString(16)
  }

  const long = 512
  const gw = width >= height ? long : Math.max(3, Math.round((long * width) / height))
  const gh = height > width ? long : Math.max(3, Math.round((long * height) / width))
  const grayRes = await base
    .clone()
    .rotate()
    .grayscale()
    .resize({ width: gw, height: gh, fit: 'inside', withoutEnlargement: true })
    .median(3)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const blurredRes = await base
    .clone()
    .rotate()
    .grayscale()
    .resize({ width: gw, height: gh, fit: 'inside', withoutEnlargement: true })
    .median(3)
    .blur(1)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const sharpness = laplacianVariance(grayRes.data, grayRes.info.width, grayRes.info.height)
  const noise = diffStd(grayRes.data, blurredRes.data)

  const statLong = 768
  const sw = width >= height ? statLong : Math.max(1, Math.round((statLong * width) / height))
  const sh = height > width ? statLong : Math.max(1, Math.round((statLong * height) / width))
  const rgb = await base
    .clone()
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: sw, height: sh, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer()
  let bSum = 0
  let sSum = 0
  const pixels = rgb.length / 3
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i]
    const g = rgb[i + 1]
    const b = rgb[i + 2]
    bSum += (r + g + b) / 3
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    sSum += mx === 0 ? 0 : (mx - mn) / mx
  }
  const brightness = bSum / pixels
  const saturation = sSum / pixels

  const { quality, detail } = computeQuality({ width, height, sharpness, brightness, saturation, noise })
  return {
    width,
    height,
    format: meta.format ?? 'unknown',
    dhash,
    phash,
    sharpness,
    brightness,
    saturation,
    noise,
    quality,
    qualityDetail: detail,
    reasons: []
  }
}

export function thumbPath(id: string): string {
  return path.join(config.thumbsDir, `${id}_t.jpg`)
}

export function previewPath(id: string): string {
  return path.join(config.thumbsDir, `${id}_p.jpg`)
}

export async function writeThumbs(id: string, input: Buffer | string, size = 384): Promise<void> {
  await sharp(input, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(thumbPath(id))
  await sharp(input, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(1440, 1440, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toFile(previewPath(id))
}

export async function removeThumbs(id: string): Promise<void> {
  await fsp.rm(thumbPath(id), { force: true })
  await fsp.rm(previewPath(id), { force: true })
}
