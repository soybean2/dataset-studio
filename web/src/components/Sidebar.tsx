import type { JSX } from 'react'
import { STATUS_LABEL, type ImageStatus } from '../api'
import { STATUS_ORDER, useStore, type View } from '../store'

const VIEWS: { key: View; label: string }[] = [
  { key: 'gallery', label: '图库' },
  { key: 'dedup', label: '近似图审查' },
  { key: 'stats', label: '质量统计' },
  { key: 'export', label: '导出训练集' },
  { key: 'settings', label: '设置' }
]

export function Sidebar(): JSX.Element {
  const { view, setView, filter, setFilter, counts } = useStore()

  return (
    <nav className="sidebar">
      <div className="nav-group">
        <div className="nav-title">工作区</div>
        {VIEWS.map(v => (
          <button key={v.key} className={`nav-item${view === v.key ? ' active' : ''}`} onClick={() => setView(v.key)}>
            <span>{v.label}</span>
          </button>
        ))}
      </div>

      <div className="nav-group">
        <div className="nav-title">状态筛选</div>
        {STATUS_ORDER.map(s => (
          <button
            key={s}
            className={`nav-item${view === 'gallery' && filter.status === s ? ' active' : ''}`}
            onClick={() => {
              setView('gallery')
              setFilter({ status: s })
            }}
          >
            <span>{STATUS_LABEL[s]}</span>
            <span className="count">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="nav-group">
        <div className="nav-title">打标状态</div>
        {[
          { key: '', label: '不限' },
          { key: 'tagged', label: '已打标' },
          { key: 'pending', label: '未打标' },
          { key: 'failed', label: '打标失败' }
        ].map(t => (
          <button
            key={t.key || 'any'}
            className={`nav-item${view === 'gallery' && filter.tagStatus === t.key ? ' active' : ''}`}
            onClick={() => {
              setView('gallery')
              setFilter({ tagStatus: t.key })
            }}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="nav-group">
        <div className="nav-title">当前筛选</div>
        <div style={{ padding: '0 9px', fontSize: 12, color: 'var(--muted)' }}>
          {filter.tag ? (
            <div>
              标签: <span className="mono">{filter.tag}</span>{' '}
              <button className="btn sm ghost" onClick={() => setFilter({ tag: '' })}>
                清除
              </button>
            </div>
          ) : null}
          {filter.status !== 'all' ? <div>状态: {STATUS_LABEL[filter.status as ImageStatus | 'all']}</div> : null}
          {typeof filter.minQuality === 'number' ? <div>质量 ≥ {filter.minQuality}</div> : null}
          {typeof filter.maxQuality === 'number' ? <div>质量 ≤ {filter.maxQuality}</div> : null}
        </div>
      </div>
    </nav>
  )
}
