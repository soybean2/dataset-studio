import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-api-'))
process.env.DATA_DIR = dataDir
process.env.TAGGER_URL = 'http://127.0.0.1:9'

const { buildApp } = await import('../server/src/index.js')

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const VOCAB = [
  '1girl', 'solo', 'long_hair', 'smile', 'blue_eyes', 'outdoors', 'sky', 'tree', 'dress', 'hat',
  'sitting', 'looking_at_viewer', 'blonde_hair', 'short_hair', 'cloud', 'water', 'night', 'city', 'book', 'cat'
]

function parseMultipart(body: Buffer, boundary: string): { filename: string; data: Buffer }[] {
  const sep = Buffer.from(`--${boundary}`)
  const out: { filename: string; data: Buffer }[] = []
  let idx = body.indexOf(sep)
  while (idx !== -1) {
    const next = body.indexOf(sep, idx + sep.length)
    if (next === -1) break
    const chunk = body.subarray(idx + sep.length, next)
    const headerEnd = chunk.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8')
      const m = /filename="([^"]*)"/.exec(headers)
      let data = chunk.subarray(headerEnd + 4)
      if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, data.length - 2)
      if (m) out.push({ filename: m[1], data })
    }
    idx = next
  }
  return out
}

function startMockTagger(): Promise<{ url: string; close: () => void; calls: () => number }> {
  let calls = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', mode: 'stub', model: 'mock-tagger', device: 'cpu', ready: true, loaded: true }))
      return
    }
    if (req.url === '/tag' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        calls++
        const body = Buffer.concat(chunks)
        const boundary = /boundary=([^\s;]+)/.exec(String(req.headers['content-type'] ?? ''))?.[1] ?? ''
        const results = parseMultipart(body, boundary).map(p => {
          const id = path.parse(p.filename).name
          const h = createHash('sha1').update(p.data).digest('hex')
          const tags: { name: string; score: number }[] = []
          for (let i = 0; i < 10 && tags.length < 8; i++) {
            const name = VOCAB[parseInt(h.slice(i * 2, i * 2 + 2), 16) % VOCAB.length]
            if (!tags.some(t => t.name === name)) tags.push({ name, score: Number((0.95 - tags.length * 0.07).toFixed(3)) })
          }
          return { id, tags, caption: tags.slice(0, 4).map(t => t.name).join(', '), error: null }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results }))
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close(), calls: () => calls })
    })
  })
}

function buildMultipart(files: { name: string; data: Buffer }[]): { body: Buffer; contentType: string } {
  const boundary = `----dsstudio${Date.now().toString(16)}`
  const parts: Buffer[] = []
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      )
    )
    parts.push(f.data, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

// 纯随机噪声对感知哈希是病态输入（改一个像素就翻一堆 bit），这里用带结构的"伪照片"做夹具
function photoLike(w: number, h: number, seed: number): Buffer {
  const buf = Buffer.alloc(w * h * 3)
  let x = seed * 7919 + 13
  const cx = 0.28 + (seed % 5) * 0.09
  const cy = 0.32 + (seed % 3) * 0.13
  for (let yy = 0; yy < h; yy++) {
    const gy = yy / h
    for (let xx = 0; xx < w; xx++) {
      const gx = xx / w
      const i = (yy * w + xx) * 3
      let r = 95 + 70 * Math.sin(gx * 6 + seed) * Math.cos(gy * 4 + seed * 0.5)
      let g = 110 + 65 * Math.cos(gx * 5 - seed * 1.3) * Math.sin(gy * 7)
      let b = 100 + 70 * Math.sin((gx + gy) * 8 + seed * 0.7)
      const dx = gx - cx
      const dy = gy - cy
      if (dx * dx + dy * dy < 0.03) {
        r = 235 - r * 0.15
        g = 205 - g * 0.15
        b = 170
      }
      if (gx > 0.62 && gx < 0.88 && gy > 0.55 && gy < 0.9) {
        r = 35
        g = 55 + 110 * gy
        b = 145
      }
      x = (x * 1103515245 + 12345) & 0x7fffffff
      const n = (x % 17) - 8
      buf[i] = clamp(r + n)
      buf[i + 1] = clamp(g + n)
      buf[i + 2] = clamp(b + n)
    }
  }
  return buf
}

async function photo(seed: number, w: number, h: number): Promise<Buffer> {
  return sharp(photoLike(w, h, seed), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  const tagger = await startMockTagger()
  const app = await buildApp()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<any> => {
    const res = await app.inject({ method, url, payload: payload as never })
    const text = res.payload
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.statusCode, json, raw: res.rawPayload, headers: res.headers }
  }

  const waitJob = async (jobId: string, timeoutMs = 60_000): Promise<{ status: string; message: string; error: string | null }> => {
    const t0 = Date.now()
    for (;;) {
      const r = await api('GET', `/api/jobs/${jobId}`)
      if (r.status === 200 && r.json.status !== 'running') return r.json
      if (Date.now() - t0 > timeoutMs) throw new Error(`任务 ${jobId} 超时`)
      await sleep(100)
    }
  }

  const health = await api('GET', '/api/health')
  check('健康检查返回 ok', health.status === 200 && health.json.ok === true, JSON.stringify(health.json.counts))
  check('初始图片数为 0', health.json.counts.all === 0)

  const settingsRes = await api('PUT', '/api/settings', {
    taggerUrl: tagger.url,
    taggerMode: 'stub',
    triggerWord: 'testchar',
    minQuality: 65,
    minEdge: 384,
    dedupThreshold: 6,
    autoQuarantine: true,
    autoAnalyze: true
  })
  check('写入设置并回显', settingsRes.status === 200 && settingsRes.json.settings.taggerUrl === tagger.url)

  const a = await photo(3, 1200, 900)
  const aNear = await sharp(a).resize(1188, 891).jpeg({ quality: 85 }).toBuffer()
  const files = [
    { name: 'a.png', data: a },
    { name: 'a_near.jpg', data: aNear },
    { name: 'b.png', data: await photo(17, 1024, 1024) },
    { name: 'c.png', data: await photo(29, 1100, 1400) },
    { name: 'tiny.png', data: await photo(44, 300, 200) },
    { name: 'flat.png', data: await sharp(Buffer.alloc(800 * 800 * 3, 128), { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer() }
  ]
  const mp = buildMultipart(files)
  const upload = await app.inject({
    method: 'POST',
    url: '/api/upload',
    headers: { 'content-type': mp.contentType },
    payload: mp.body
  })
  const uploadJson = JSON.parse(upload.payload) as { imported: number; skipped: number; errors: string[]; ids: string[]; jobId?: string }
  check('上传 6 张图片', uploadJson.imported === 6, JSON.stringify({ imported: uploadJson.imported, errors: uploadJson.errors }))
  check('上传后自动触发分析任务', Boolean(uploadJson.jobId), String(uploadJson.jobId))

  const uploadAgain = await app.inject({ method: 'POST', url: '/api/upload', headers: { 'content-type': mp.contentType }, payload: mp.body })
  const againJson = JSON.parse(uploadAgain.payload) as { imported: number; skipped: number }
  check('重复上传被跳过', againJson.imported === 0 && againJson.skipped === 6, JSON.stringify(againJson))

  const analyzeJob = await waitJob(uploadJson.jobId!)
  check('分析任务完成', analyzeJob.status === 'done', analyzeJob.message)

  const counts = (await api('GET', '/api/health')).json.counts as Record<string, number>
  const allItems = ((await api('GET', '/api/images?pageSize=100')).json.items ?? []) as { id: string; fileName: string; quality: number | null }[]
  const qualityDump = allItems.map(i => `${i.fileName}=${i.quality}`).join(' ')
  check(
    '质量与去重结果: active=3 dup=1 low_quality=2',
    counts.active === 3 && counts.dup === 1 && counts.low_quality === 2,
    `${JSON.stringify(counts)} | ${qualityDump}`
  )

  const dupList = await api('GET', '/api/images?status=dup')
  const dupItem = dupList.json.items[0]
  check('近似图被自动隔离', dupList.json.total === 1 && dupItem.fileName === 'a_near.jpg', JSON.stringify(dupItem?.fileName))
  check('隔离图带分组信息', Boolean(dupItem.groupId) && dupItem.isGroupKeep === false, JSON.stringify({ g: dupItem.groupId, keep: dupItem.isGroupKeep }))

  const lowList = await api('GET', '/api/images?status=low_quality')
  check('低质图被自动隔离且带原因', lowList.json.total === 2 && lowList.json.items.every((i: { reasons: string[] }) => i.reasons.length > 0), JSON.stringify(lowList.json.items.map((i: { fileName: string; reasons: string[] }) => `${i.fileName}:${i.reasons.join('|')}`)))

  const search = await api('GET', '/api/images?q=b.png')
  check('按文件名搜索', search.json.total === 1 && search.json.items[0].fileName === 'b.png')
  const sorted = await api('GET', '/api/images?status=active&sort=quality_desc')
  const qualities = sorted.json.items.map((i: { quality: number }) => i.quality)
  check('按质量分降序', qualities.every((q: number, idx: number) => idx === 0 || qualities[idx - 1] >= q), JSON.stringify(qualities))

  const activeItem = sorted.json.items[0] as { id: string; mime: string }
  const activeId = activeItem.id
  const thumb = await api('GET', `/img/${activeId}/thumb`)
  check('缩略图可访问', thumb.status === 200 && thumb.headers['content-type'] === 'image/jpeg' && thumb.raw.length > 1000, `${thumb.status} ${thumb.raw.length}B`)
  const preview = await api('GET', `/img/${activeId}/preview`)
  check('预览图可访问', preview.status === 200 && preview.raw.length > thumb.raw.length, `${preview.raw.length}B`)
  const original = await api('GET', `/img/${activeId}/original`)
  check('原图可访问且 mime 正确', original.status === 200 && original.headers['content-type'] === activeItem.mime, `${original.status} ${original.headers['content-type']} != ${activeItem.mime}`)
  const badId = await api('GET', '/img/zzzz/thumb')
  check('非法 id 被拒绝', badId.status === 400, String(badId.status))
  const traversal = await app.inject({ method: 'GET', url: '/img/..%2F..%2F..%2Fetc%2Fpasswd/thumb' })
  check(
    '路径穿越被拒绝',
    traversal.statusCode === 400 && !String(traversal.headers['content-type'] ?? '').startsWith('image/'),
    `${traversal.statusCode} ${traversal.headers['content-type'] ?? ''}`
  )

  const taggerHealth = await api('GET', '/api/tagger/health')
  check('打标服务健康检查', taggerHealth.json.ok === true && taggerHealth.json.mode === 'stub', JSON.stringify(taggerHealth.json))

  const tagStart = await api('POST', '/api/tag', {})
  const tagJob = await waitJob(tagStart.json.jobId)
  check('批量打标任务完成', tagJob.status === 'done', `${tagJob.message} ${tagJob.error ?? ''}`)
  check('打标服务被调用', tagger.calls() > 0, `calls=${tagger.calls()}`)
  const tagged = await api('GET', '/api/images?status=active')
  const taggedItems = tagged.json.items as { id: string; tags: string[]; caption: string; tagStatus: string; tagSource: string }[]
  check('全部图片获得标签', taggedItems.every(i => i.tagStatus === 'tagged' && i.tags.length > 0), JSON.stringify(taggedItems.map(i => i.tags.length)))
  check('caption 含触发词', taggedItems.every(i => i.caption.startsWith('testchar')), taggedItems[0]?.caption)
  check('标签来源被记录', taggedItems.every(i => i.tagSource === 'mock-tagger'), taggedItems[0]?.tagSource)

  const target = taggedItems[0]
  const patched = await api('PATCH', `/api/images/${target.id}`, { caption: 'manual caption', tags: ['manual_tag', 'solo'] })
  check('手动修改 caption 与标签', patched.json.caption === 'manual caption' && patched.json.tags.join(',') === 'manual_tag,solo', JSON.stringify(patched.json.tags))

  const twoIds = taggedItems.slice(0, 2).map(i => i.id)
  const batchAdd = await api('POST', '/api/images/batch', { ids: twoIds, addTags: ['extra_tag'], appendCaption: 'batchnote' })
  check('批量加标签返回更新数', batchAdd.json.updated === 2, JSON.stringify(batchAdd.json))
  const afterAdd = await api('GET', `/api/images/${twoIds[1]}`)
  check('批量加标签生效', afterAdd.json.tags.includes('extra_tag') && afterAdd.json.caption.includes('batchnote'), JSON.stringify(afterAdd.json.tags))
  await api('POST', '/api/images/batch', { ids: twoIds, removeTags: ['extra_tag'] })
  const afterRemove = await api('GET', `/api/images/${twoIds[1]}`)
  check('批量移除标签生效', !afterRemove.json.tags.includes('extra_tag'), JSON.stringify(afterRemove.json.tags))

  const groups = await api('GET', '/api/groups?minSize=2')
  const activeKeepId = allItems.find(i => i.fileName === 'a.png')!.id
  const group = groups.json.groups[0] as { groupId: string; size: number; keepId: string; images: { id: string; fileName: string }[] }
  check('近似图分组可查询', groups.json.groups.length === 1 && group.size === 2, JSON.stringify({ n: groups.json.groups.length, size: group?.size }))
  const otherMemberId = group.keepId
  check('分组保留图与自动隔离结果一致', otherMemberId === activeKeepId, `${group.keepId} vs ${activeKeepId}`)
  const keepSwap = await api('POST', `/api/groups/${group.groupId}/keep`, { id: dupItem.id })
  check('切换保留图成功', keepSwap.json.updated === 2, JSON.stringify(keepSwap.json))
  const afterSwap = await api('GET', `/api/images/${dupItem.id}`)
  check('切换后原重复图变为 active 且被标记保护', afterSwap.json.status === 'active' && afterSwap.json.isGroupKeep === true && afterSwap.json.pinned === true, JSON.stringify({ s: afterSwap.json.status, keep: afterSwap.json.isGroupKeep, p: afterSwap.json.pinned }))
  const afterSwapOther = await api('GET', `/api/images/${otherMemberId}`)
  check('切换后原保留图被隔离', afterSwapOther.json.status === 'dup', afterSwapOther.json.status)

  await api('POST', '/api/dedup/run', {})
  const afterRerun = await api('GET', `/api/images/${dupItem.id}`)
  const afterRerunOther = await api('GET', `/api/images/${otherMemberId}`)
  check(
    '重跑去重不覆盖手动保留选择',
    afterRerun.json.status === 'active' && afterRerun.json.isGroupKeep === true && afterRerunOther.json.status === 'dup',
    JSON.stringify({ keep: afterRerun.json.status, other: afterRerunOther.json.status })
  )

  const restored = await api('POST', `/api/images/${otherMemberId}/restore`)
  check('隔离区恢复为 active 且受保护', restored.json.status === 'active' && restored.json.pinned === true, JSON.stringify({ s: restored.json.status, p: restored.json.pinned }))
  await api('POST', '/api/dedup/run', {})
  const afterRestoreRerun = await api('GET', `/api/images/${otherMemberId}`)
  check('重跑去重不覆盖手动恢复', afterRestoreRerun.json.status === 'active', afterRestoreRerun.json.status)

  const stats = await api('GET', '/api/stats')
  check('统计接口返回直方图与标签云', stats.json.histogram.length === 10 && stats.json.tags.length > 0, JSON.stringify({ h: stats.json.histogram.length, t: stats.json.tags.length }))

  const activeBefore = ((await api('GET', '/api/health')).json.counts as Record<string, number>).active
  const exportRes = await api('POST', '/api/export', {})
  const exportJob = await waitJob(exportRes.json.jobId)
  check('导出任务完成', exportJob.status === 'done', exportJob.message)
  const outDir = exportRes.json.outDir as string
  const trainFiles = fs.readdirSync(path.join(outDir, 'train'))
  const jpgs = trainFiles.filter(f => f.endsWith('.jpg'))
  const txts = trainFiles.filter(f => f.endsWith('.txt'))
  const metadata = JSON.parse(fs.readFileSync(path.join(outDir, 'metadata.json'), 'utf8')) as unknown[]
  check('导出图片数与 active 一致', jpgs.length === activeBefore && txts.length === activeBefore, `jpg=${jpgs.length} txt=${txts.length} active=${activeBefore}`)
  check('metadata.json 条目数一致', metadata.length === activeBefore, `meta=${metadata.length}`)
  check('导出 ZIP 生成', fs.existsSync(`${outDir}.zip`), `${outDir}.zip`)
  const captionFile = fs.readFileSync(path.join(outDir, 'train', txts[0]), 'utf8')
  check('caption 文本文件有内容', captionFile.length > 0, captionFile.slice(0, 60))
  const exportsList = await api('GET', '/api/exports')
  check('导出历史可查询', exportsList.json.exports.length >= 1, JSON.stringify(exportsList.json.exports.map((e: { name: string }) => e.name)))

  const excluded = await api('DELETE', `/api/images/${twoIds[0]}`)
  check('软删除标记为 excluded', excluded.json.ok === true && (await api('GET', `/api/images/${twoIds[0]}`)).json.status === 'excluded')
  const hardDeleted = await api('DELETE', `/api/images/${twoIds[0]}?hard=1`)
  check('硬删除移除记录', hardDeleted.json.ok === true && (await api('GET', `/api/images/${twoIds[0]}`)).status === 404)

  const tight = await api('PUT', '/api/settings', { minQuality: 99 })
  check('提高质量阈值后自动重新隔离', tight.json.dedup.lowQuality >= 1, JSON.stringify(tight.json.dedup))

  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address() as { port: number }
  let sseOk = false
  let sseDetail = ''
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`, { signal: AbortSignal.timeout(4000) })
    const reader = res.body?.getReader()
    const first = await reader?.read()
    sseDetail = new TextDecoder().decode(first?.value ?? new Uint8Array())
    sseOk = sseDetail.includes(': connected')
    await reader?.cancel()
  } catch (e) {
    sseDetail = String(e)
  }
  check('SSE 事件流可连接', sseOk, sseDetail.slice(0, 60))

  await app.close()
  tagger.close()

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  console.log(dataDir)
  // SQLite 句柄不关会导致 Windows 下临时目录删不掉
  const { closeDb } = await import('../server/src/db.js')
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}

void main().catch(e => {
  console.error('FATAL', e)
  process.exit(2)
})
