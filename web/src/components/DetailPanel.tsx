import { useEffect, useState, type JSX } from 'react'
import { STATUS_LABEL, THUMB_QUALITY_COLOR } from '../api'
import { useStore } from '../store'
import { METRIC_LABEL, formatBytes, formatTime } from '../util'

export function DetailPanel(): JSX.Element | null {
  const { current, setCurrent, patchImage, remove, restore, runTag, runAnalyze, setFilter, setView, busy, tagger } = useStore()
  const [caption, setCaption] = useState('')
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    setCaption(current?.caption ?? '')
    setTagInput('')
  }, [current?.id, current?.caption])

  if (!current) return null
  const img = current
  const dirty = caption !== img.caption

  const addTags = (): void => {
    const list = tagInput
      .split(/[,，\n]/)
      .map(s => s.trim())
      .filter(Boolean)
    if (!list.length) return
    void patchImage(img.id, { tags: [...new Set([...img.tags, ...list])] })
    setTagInput('')
  }

  return (
    <aside className="detail">
      <div>
        <img className="preview" src={img.previewUrl} alt={img.fileName} />
      </div>

      <div className="section">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${img.status}`}>{STATUS_LABEL[img.status]}</span>
          {img.pinned ? <span className="badge pinned">锁定</span> : null}
          {img.groupId ? <span className="badge dup">近似组 {img.groupId.slice(4, 10)}</span> : null}
          {img.isGroupKeep && img.groupId ? <span className="badge active">组内保留</span> : null}
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={() => setCurrent(null)} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{img.fileName}</div>
      </div>

      <div className="section">
        <h3>质量</h3>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 30, fontWeight: 700, color: THUMB_QUALITY_COLOR(img.quality), fontVariantNumeric: 'tabular-nums' }}>
            {img.quality ?? '–'}
          </span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>/ 100</span>
        </div>
        {img.qualityDetail
          ? Object.entries(img.qualityDetail).map(([k, v]) => (
              <div className="metric" key={k}>
                <span className="label">{METRIC_LABEL[k] ?? k}</span>
                <span className="bar">
                  <i style={{ width: `${Math.round(v * 100)}%` }} />
                </span>
                <span className="num">{Math.round(v * 100)}</span>
              </div>
            ))
          : null}
        {img.reasons.length ? (
          <div className="reasons">
            {img.reasons.map(r => (
              <span className="reason" key={r}>
                {r}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="section">
        <h3>描述 / 标签</h3>
        <textarea
          className="field"
          rows={4}
          value={caption}
          onChange={e => setCaption(e.target.value)}
          placeholder="训练用描述文本（写入 .txt）"
        />
        <div className="actions">
          <button className="btn sm primary" disabled={!dirty || busy !== null} onClick={() => void patchImage(img.id, { caption })}>
            保存描述
          </button>
          <button className="btn sm" disabled={!dirty || busy !== null} onClick={() => setCaption(img.caption)}>
            撤销
          </button>
          <button
            className="btn sm"
            disabled={busy !== null}
            title={tagger.ok ? `使用 ${tagger.model || '本地模型'} 重新打标` : `打标服务不可用: ${tagger.error ?? ''}`}
            onClick={() => void runTag([img.id])}
          >
            重新打标
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {img.tagStatus === 'tagged' ? `来源 ${img.tagSource ?? '-'}` : img.tagStatus === 'failed' ? `失败: ${img.tagError ?? ''}` : '未打标'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder="添加标签，回车确认"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addTags()
            }}
          />
          <button className="btn sm" disabled={busy !== null} onClick={addTags}>
            添加
          </button>
        </div>
        <div className="tags">
          {img.tags.length === 0 ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>暂无标签</span> : null}
          {img.tags.map(t => (
            <span className="tag" key={t}>
              {t}
              {img.tagScores?.[t] !== undefined ? <span className="score">{img.tagScores[t].toFixed(2)}</span> : null}
              <button
                title="移除"
                onClick={() => void patchImage(img.id, { tags: img.tags.filter(x => x !== t) })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>信息</h3>
        <div className="kv">
          <span className="k">尺寸</span>
          <span className="v">
            {img.width} × {img.height}
          </span>
          <span className="k">大小</span>
          <span className="v">{formatBytes(img.bytes)}</span>
          <span className="k">格式</span>
          <span className="v">{img.mime || '-'}</span>
          <span className="k">清晰度</span>
          <span className="v">{img.sharpness?.toFixed(1) ?? '-'}</span>
          <span className="k">亮度</span>
          <span className="v">{img.brightness?.toFixed(1) ?? '-'}</span>
          <span className="k">饱和度</span>
          <span className="v">{img.saturation?.toFixed(3) ?? '-'}</span>
          <span className="k">噪点</span>
          <span className="v">{img.noise?.toFixed(2) ?? '-'}</span>
          <span className="k">导入</span>
          <span className="v">{formatTime(img.importedAt)}</span>
          <span className="k">ID</span>
          <span className="v mono">{img.id}</span>
        </div>
      </div>

      <div className="section">
        <h3>操作</h3>
        <div className="actions">
          {img.status !== 'active' ? (
            <button className="btn sm" disabled={busy !== null} onClick={() => void restore(img.id)}>
              恢复为可用并锁定
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={busy !== null}
              onClick={() => void patchImage(img.id, { pinned: !img.pinned })}
              title="锁定后自动去重/质量剔除不会改动它"
            >
              {img.pinned ? '取消锁定' : '锁定'}
            </button>
          )}
          <button className="btn sm" disabled={busy !== null} onClick={() => void runAnalyze([img.id])}>
            重新分析
          </button>
          {img.groupId ? (
            <button
              className="btn sm"
              onClick={() => {
                setView('dedup')
                setFilter({ groupId: img.groupId! })
              }}
            >
              查看近似组
            </button>
          ) : null}
          <a className="btn sm" href={`/img/${img.id}/original`} target="_blank" rel="noreferrer">
            打开原图
          </a>
          <button className="btn sm" disabled={busy !== null} onClick={() => void patchImage(img.id, { status: 'excluded' })}>
            排除
          </button>
          <button
            className="btn sm danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm('彻底删除该图片的文件与记录？此操作不可恢复。')) void remove(img.id, true)
            }}
          >
            删除
          </button>
        </div>
      </div>
    </aside>
  )
}
