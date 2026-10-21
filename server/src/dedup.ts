import { db, type ImageRow } from './db.js'
import { hammingHex, hashDistance } from './image-engine.js'
import { listHashedImages, toDto, updateImage, type HashRow, type ImageDto } from './repo.js'
import { publish } from './events.js'

export interface RegroupOptions {
  threshold: number
  minQuality: number
  minEdge: number
  autoQuarantine: boolean
}

export interface DedupSummary {
  scanned: number
  groups: number
  duplicates: number
  lowQuality: number
  changed: number
}

export interface GroupView {
  groupId: string
  size: number
  keepId: string | null
  images: ImageDto[]
}

function findParent(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]]
    i = parent[i]
  }
  return i
}

function rank(a: HashRow, b: HashRow): number {
  if (b.quality !== a.quality) return b.quality - a.quality
  const areaDiff = b.width * b.height - a.width * a.height
  if (areaDiff !== 0) return areaDiff
  return a.imported_at - b.imported_at
}

function desiredStatus(row: HashRow, isDup: boolean, opts: RegroupOptions): 'active' | 'dup' | 'low_quality' {
  if (!opts.autoQuarantine) return 'active'
  const lowQuality = row.quality < opts.minQuality || Math.min(row.width, row.height) < opts.minEdge
  if (lowQuality) return 'low_quality'
  if (isDup) return 'dup'
  return 'active'
}

export function regroup(opts: RegroupOptions): DedupSummary {
  const rows = listHashedImages()
  const n = rows.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const margin = opts.threshold + 12

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // dHash 先做粗筛，避免全量比较 1024bit pHash；近似图的 dHash 距离通常同样很小
      if (hammingHex(rows[i].dhash, rows[j].dhash) > margin) continue
      if (hashDistance(rows[i], rows[j]) <= opts.threshold) {
        const ri = findParent(parent, i)
        const rj = findParent(parent, j)
        if (ri !== rj) parent[rj] = ri
      }
    }
  }

  const clusters = new Map<number, HashRow[]>()
  for (let i = 0; i < n; i++) {
    const root = findParent(parent, i)
    const list = clusters.get(root)
    if (list) list.push(rows[i])
    else clusters.set(root, [rows[i]])
  }

  let duplicates = 0
  let lowQuality = 0
  let changed = 0
  const groups: { groupId: string; members: HashRow[]; keep: HashRow }[] = []
  for (const members of clusters.values()) {
    if (members.length < 2) continue
    // 手动保留(pinned)的成员优先当组长，这样重跑去重不会推翻用户的选择
    const sorted = [...members].sort((a, b) => b.pinned - a.pinned || rank(a, b))
    groups.push({ groupId: `grp_${sorted[0].id}`, members: sorted, keep: sorted[0] })
  }
  const keepIdByImage = new Map<string, string>()
  for (const g of groups) for (const m of g.members) keepIdByImage.set(m.id, g.keep.id)

  const apply = db.transaction(() => {
    for (const row of rows) {
      const groupId = groups.length && keepIdByImage.has(row.id) ? `grp_${keepIdByImage.get(row.id)}` : null
      const isDup = groupId !== null && keepIdByImage.get(row.id) !== row.id
      if (isDup) duplicates++
      const next = desiredStatus(row, isDup, opts)
      if (next === 'low_quality') lowQuality++
      const full = db.prepare('SELECT status, group_id, is_group_keep, pinned FROM images WHERE id = ?').get(row.id) as
        | { status: string; group_id: string | null; is_group_keep: number; pinned: number }
        | undefined
      if (!full) continue
      const isKeep = !isDup && groupId !== null
      const keepFlag = groupId === null ? 1 : isKeep ? 1 : 0
      if (full.status === next && full.group_id === groupId && full.is_group_keep === keepFlag) continue
      if (full.pinned === 1 && full.status !== 'pending') {
        if (full.group_id !== groupId || full.is_group_keep !== keepFlag) {
          updateImage(row.id, { group_id: groupId, is_group_keep: keepFlag })
          changed++
        }
        continue
      }
      updateImage(row.id, { status: next, group_id: groupId, is_group_keep: keepFlag })
      changed++
      const fresh = db.prepare('SELECT * FROM images WHERE id = ?').get(row.id) as ImageRow | undefined
      if (fresh) publish('image', toDto(fresh))
    }
  })
  apply()

  return { scanned: n, groups: groups.length, duplicates, lowQuality, changed }
}

export function listGroups(minSize = 2): GroupView[] {
  const rows = db
    .prepare(
      `SELECT group_id AS groupId, COUNT(*) AS size FROM images
       WHERE group_id IS NOT NULL AND status != 'excluded'
       GROUP BY group_id HAVING COUNT(*) >= ? ORDER BY size DESC`
    )
    .all(minSize) as { groupId: string; size: number }[]
  const stmt = db.prepare('SELECT * FROM images WHERE group_id = ? ORDER BY is_group_keep DESC, quality DESC')
  return rows.map(r => {
    const images = (stmt.all(r.groupId) as ImageRow[]).map(toDto)
    return { groupId: r.groupId, size: r.size, keepId: images.find(i => i.isGroupKeep)?.id ?? null, images }
  })
}

export function setGroupKeep(groupId: string, keepId: string): { updated: number; groupId: string } {
  const members = db
    .prepare("SELECT id, status, pinned FROM images WHERE group_id = ? AND status != 'excluded'")
    .all(groupId) as { id: string; status: string; pinned: number }[]
  if (!members.some(m => m.id === keepId)) throw new Error('保留图不属于该分组')
  const nextGroupId = `grp_${keepId}`
  let updated = 0
  const tx = db.transaction(() => {
    for (const m of members) {
      const isKeep = m.id === keepId
      updateImage(m.id, {
        is_group_keep: isKeep ? 1 : 0,
        group_id: nextGroupId,
        pinned: isKeep ? 1 : 0,
        status: isKeep ? 'active' : m.status === 'low_quality' ? 'low_quality' : 'dup'
      })
      updated++
      const row = db.prepare('SELECT * FROM images WHERE id = ?').get(m.id) as ImageRow | undefined
      if (row) publish('image', toDto(row))
    }
  })
  tx()
  return { updated, groupId: nextGroupId }
}
