import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-engine-'))
process.env.DATA_DIR = dataDir

const { analyzeImage, computeQuality, hammingHex, hashDistance, previewPath, qualityReasons, thumbPath, writeThumbs } =
  await import('../server/src/image-engine.js')

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

async function noiseImage(seed: number, w: number, h: number, blur = 0): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3)
  let x = seed
  for (let i = 0; i < buf.length; i += 3) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    const base = 40 + (x % 170)
    buf[i] = Math.min(255, base + (seed % 80))
    buf[i + 1] = Math.min(255, base + ((x >> 5) % 60))
    buf[i + 2] = Math.min(255, base + ((x >> 9) % 120))
  }
  let pipeline = sharp(buf, { raw: { width: w, height: h, channels: 3 } })
  if (blur > 0) pipeline = pipeline.blur(blur)
  return pipeline.png().toBuffer()
}

async function main(): Promise<void> {
  const a = await noiseImage(1234, 1200, 900)
  const aCopy = await noiseImage(1234, 1200, 900)
  const aNear = await sharp(a).resize(1190, 895).jpeg({ quality: 88 }).toBuffer()
  const b = await noiseImage(777, 1024, 1024)
  const blurry = await noiseImage(1234, 1200, 900, 6)
  const tiny = await noiseImage(55, 300, 200)
  const flat = Buffer.alloc(800 * 800 * 3, 128)
  const flatPng = await sharp(flat, { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer()

  const [ra, raCopy, raNear, rb, rBlurry, rTiny, rFlat] = await Promise.all(
    [a, aCopy, aNear, b, blurry, tiny, flatPng].map(x => analyzeImage(x))
  )

  check('尺寸识别 1200x900', ra.width === 1200 && ra.height === 900, `${ra.width}x${ra.height}`)
  check('相同图片哈希距离为 0', hashDistance(ra, raCopy) === 0)
  check('近似缩放图距离小于阈值 6', hashDistance(ra, raNear) <= 6, `dist=${hashDistance(ra, raNear)}`)
  check('不同图片距离大于阈值 6', hashDistance(ra, rb) > 6, `dist=${hashDistance(ra, rb)}`)
  check('dHash 为 16 位十六进制', /^[0-9a-f]{16}$/.test(ra.dhash), ra.dhash)
  check('pHash 为 256 位十六进制', /^[0-9a-f]{256}$/.test(ra.phash), `len=${ra.phash.length}`)
  check('hammingHex 单位差为 1', hammingHex('00', '01') === 1 && hammingHex('ff', '00') === 8)
  check('清晰图清晰度高于模糊图', ra.sharpness > rBlurry.sharpness * 2, `a=${ra.sharpness.toFixed(1)} blur=${rBlurry.sharpness.toFixed(1)}`)
  check('清晰图质量分高于模糊图', ra.quality > rBlurry.quality, `${ra.quality} vs ${rBlurry.quality}`)
  check('平坦图被判为模糊', qualityReasons({ ...rFlat, minEdge: 384 }).some(r => r.includes('模糊')), qualityReasons({ ...rFlat, minEdge: 384 }).join('|'))
  check('小图命中短边规则', qualityReasons({ ...rTiny, minEdge: 384 }).some(r => r.includes('短边')), qualityReasons({ ...rTiny, minEdge: 384 }).join('|'))
  check('正常图无拒绝理由', qualityReasons({ ...ra, minEdge: 384 }).length === 0, qualityReasons({ ...ra, minEdge: 384 }).join('|'))
  check('质量分区间 0-100', ra.quality >= 0 && ra.quality <= 100 && rFlat.quality >= 0, `${ra.quality}/${rFlat.quality}`)
  const q = computeQuality({ width: 1200, height: 900, sharpness: 60, brightness: 128, saturation: 0.3, noise: 4 })
  check('优质图质量分较高', q.quality > 80, JSON.stringify(q))

  const id = 'test0000test0000'
  await writeThumbs(id, a, 384)
  const tMeta = await sharp(thumbPath(id)).metadata()
  const pMeta = await sharp(previewPath(id)).metadata()
  check('缩略图长边 384', Math.max(tMeta.width ?? 0, tMeta.height ?? 0) === 384, `${tMeta.width}x${tMeta.height}`)
  check('预览图长边 1200', Math.max(pMeta.width ?? 0, pMeta.height ?? 0) === 1200, `${pMeta.width}x${pMeta.height}`)

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}

void main()
