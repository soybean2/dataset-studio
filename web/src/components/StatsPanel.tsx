import { useEffect, useState, type JSX } from 'react'
import { api, STATUS_LABEL, type ImageStatus, type Stats } from '../api'
import { useStore } from '../store'

const CARD_KEYS: (ImageStatus | 'all')[] = ['all', 'active', 'pending', 'dup', 'low_quality', 'excluded']

export function StatsPanel(): JSX.Element {
  const { setFilter, setView, pushToast } = useStore()
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch(e => pushToast(String(e), 'error'))
  }, [pushToast])

  if (!stats) return <div className="panel"><div className="empty">加载中…</div></div>

  const maxBucket = Math.max(1, ...stats.histogram.map(h => h.count))
  const maxTag = Math.max(1, ...stats.tags.map(t => t.count))

  const goto = (patch: Parameters<typeof setFilter>[0]): void => {
    setView('gallery')
    setFilter(patch)
  }

  return (
    <div className="panel">
      <h2>质量统计</h2>
      <p className="hint">点击任意卡片、柱状图或标签可跳到图库并按该条件筛选。</p>

      <div className="cards">
        {CARD_KEYS.map(k => (
          <button className="stat-card" key={k} style={{ textAlign: 'left' }} onClick={() => goto({ status: k })}>
            <div className="n">{stats.counts[k] ?? 0}</div>
            <div className="t">{STATUS_LABEL[k]}</div>
          </button>
        ))}
      </div>

      <div className="section" style={{ marginBottom: 22 }}>
        <h3>质量分布</h3>
        <div className="hist">
          {stats.histogram.map(h => (
            <button
              className="col"
              key={h.bucket}
              title={`${h.bucket}: ${h.count} 张`}
              onClick={() => goto({ status: 'all', minQuality: Number(h.bucket.split('-')[0]), maxQuality: Number(h.bucket.split('-')[1]) })}
            >
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.count || ''}</span>
              <span className="stack" style={{ height: `${(h.count / maxBucket) * 100}%` }} />
              <span className="lbl">{h.bucket}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="section" style={{ marginBottom: 22 }}>
        <h3>标签词表（{stats.tags.length}）</h3>
        {stats.tags.length === 0 ? <div className="empty">还没有标签，先在顶栏点「批量打标」。</div> : null}
        <div className="tags">
          {stats.tags.map(t => (
            <button
              className="tag clickable"
              key={t.tag}
              style={{ opacity: 0.45 + 0.55 * (t.count / maxTag) }}
              onClick={() => goto({ status: 'all', tag: t.tag })}
            >
              {t.tag} <span className="score">{t.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>打标服务</h3>
        <div className="kv">
          <span className="k">状态</span>
          <span className="v">{stats.tagger.ok ? '已连接' : `不可用 ${stats.tagger.error ?? ''}`}</span>
          <span className="k">地址</span>
          <span className="v mono">{stats.settings.taggerUrl}</span>
          <span className="k">模式</span>
          <span className="v">
            {stats.tagger.mode || stats.settings.taggerMode} {stats.tagger.model ? `· ${stats.tagger.model}` : ''}{' '}
            {stats.tagger.device ? `· ${stats.tagger.device}` : ''}
          </span>
          <span className="k">阈值</span>
          <span className="v">
            {stats.settings.taggerThreshold} / 最多 {stats.settings.taggerMaxTags} 个
          </span>
          <span className="k">触发词</span>
          <span className="v">{stats.settings.triggerWord || '（未设置）'}</span>
        </div>
      </div>
    </div>
  )
}
