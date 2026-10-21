import { useCallback, useEffect, useState, type JSX } from 'react'
import { api, STATUS_LABEL, type GroupView } from '../api'
import { useStore } from '../store'

export function DedupPanel(): JSX.Element {
  const { filter, setFilter, runDedup, setCurrent, remove, busy, pushToast } = useStore()
  const [groups, setGroups] = useState<GroupView[]>([])
  const [loading, setLoading] = useState(false)
  const [minSize, setMinSize] = useState(2)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.groups(minSize)
      setGroups(r.groups)
    } catch (e) {
      pushToast(String(e), 'error')
    } finally {
      setLoading(false)
    }
  }, [minSize, pushToast])

  useEffect(() => {
    void load()
  }, [load, filter.groupId])

  const shown = filter.groupId ? groups.filter(g => g.groupId === filter.groupId) : groups
  const totalDups = groups.reduce((n, g) => n + g.images.filter(i => i.status === 'dup').length, 0)

  const keep = async (g: GroupView, id: string): Promise<void> => {
    try {
      await api.setKeep(g.groupId, id)
      await load()
    } catch (e) {
      pushToast(String(e), 'error')
    }
  }

  const dropDups = async (g: GroupView, hard: boolean): Promise<void> => {
    const targets = g.images.filter(i => i.status === 'dup' && !i.pinned)
    if (!targets.length) return
    if (!window.confirm(`${hard ? '彻底删除' : '排除'}该组 ${targets.length} 张重复图？`)) return
    await Promise.all(targets.map(i => remove(i.id, hard)))
    await load()
  }

  return (
    <div className="panel">
      <h2>近似图审查</h2>
      <p className="hint">
        按感知哈希聚类。每组默认保留质量最高的一张，其余自动标为「近似重复」并排除在导出之外；点「保留这张」可手动改选，改选后会被锁定，重跑去重不会推翻。
      </p>

      <div className="actions" style={{ marginBottom: 14 }}>
        <button className="btn primary" disabled={busy !== null} onClick={() => void runDedup().then(load)}>
          重新扫描
        </button>
        <button className="btn" disabled={loading} onClick={() => void load()}>
          刷新列表
        </button>
        <label className="slider">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>最小组大小</span>
          <select className="field" value={minSize} onChange={e => setMinSize(Number(e.target.value))}>
            {[2, 3, 4, 5].map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', alignSelf: 'center' }}>
          {groups.length} 组 · 待处理重复 {totalDups} 张
        </span>
        {filter.groupId ? (
          <button className="btn sm" onClick={() => setFilter({ groupId: '' })}>
            清除分组筛选
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? <div className="empty">{loading ? '扫描中…' : '没有发现近似重复的图片。'}</div> : null}

      {shown.map(g => (
        <div className="group" key={g.groupId}>
          <div className="group-head">
            <strong style={{ color: 'var(--text)' }}>{g.size} 张近似</strong>
            <span className="mono">{g.groupId}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" disabled={busy !== null} onClick={() => void dropDups(g, false)}>
              排除重复
            </button>
            <button className="btn sm danger" disabled={busy !== null} onClick={() => void dropDups(g, true)}>
              彻底删除重复
            </button>
          </div>
          <div className="group-items">
            {g.images.map(img => (
              <div className={`gcell${img.isGroupKeep ? ' keep' : ''}`} key={img.id}>
                <img src={img.thumbUrl} alt={img.fileName} loading="lazy" onClick={() => setCurrent(img)} style={{ cursor: 'pointer' }} />
                <div className="foot">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={img.fileName}>
                    {img.fileName}
                  </span>
                  <span>
                    质量 {img.quality ?? '–'} · {img.width}×{img.height} · <span className={`badge ${img.status}`}>{STATUS_LABEL[img.status]}</span>
                  </span>
                  <div className="actions">
                    <button className="btn sm" disabled={img.isGroupKeep || busy !== null} onClick={() => void keep(g, img.id)}>
                      {img.isGroupKeep ? '当前保留' : '保留这张'}
                    </button>
                    {img.pinned ? <span className="badge pinned">锁定</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
