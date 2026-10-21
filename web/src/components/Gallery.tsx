import { useCallback, useRef, useState, type DragEvent, type JSX } from 'react'
import { useStore } from '../store'
import { ImageGrid } from './ImageGrid'
import { DetailPanel } from './DetailPanel'
import { SelectionBar } from './SelectionBar'

const PAGE_SIZES = [30, 60, 120, 200]

export function Gallery(): JSX.Element {
  const { filter, setFilter, total, items, loading, error, refresh, upload } = useStore()
  const [drag, setDrag] = useState(false)
  const [cell, setCell] = useState(168)
  const dragDepth = useRef(0)

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragDepth.current = 0
      setDrag(false)
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?|gif|avif)$/i.test(f.name))
      if (files.length) void upload(files)
    },
    [upload]
  )

  const pages = Math.max(1, Math.ceil(total / filter.pageSize))

  return (
    <>
      <div className="gallery">
      <div className="gallery-bar">
        <input
          className="field grow"
          placeholder="搜索文件名 / 描述 / 标签…"
          value={filter.q}
          onChange={e => setFilter({ q: e.target.value })}
        />
        <input
          className="field"
          style={{ width: 120 }}
          placeholder="标签精确匹配"
          value={filter.tag}
          onChange={e => setFilter({ tag: e.target.value })}
        />
        <select className="field" value={filter.sort} onChange={e => setFilter({ sort: e.target.value })}>
          <option value="newest">最新导入</option>
          <option value="oldest">最早导入</option>
          <option value="quality_desc">质量从高到低</option>
          <option value="quality_asc">质量从低到高</option>
          <option value="size_desc">文件最大</option>
          <option value="name">文件名</option>
        </select>
        <span className="slider" title="质量分下限">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>质量≥</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={filter.minQuality ?? 0}
            onChange={e => setFilter({ minQuality: Number(e.target.value) || undefined })}
          />
          <span className="mono" style={{ width: 24 }}>{filter.minQuality ?? 0}</span>
        </span>
        <select className="field" value={filter.pageSize} onChange={e => setFilter({ pageSize: Number(e.target.value) })}>
          {PAGE_SIZES.map(n => (
            <option key={n} value={n}>
              {n} / 页
            </option>
          ))}
        </select>
        <div className="slider" title="缩略图大小">
          <input type="range" min={110} max={300} step={6} value={cell} onChange={e => setCell(Number(e.target.value))} />
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>

      <SelectionBar />

      {error ? <div className="selection-bar" style={{ background: '#3a2224' }}>{error}</div> : null}

      <div
        className="grid-scroll"
        onDragEnter={e => {
          e.preventDefault()
          dragDepth.current++
          setDrag(true)
        }}
        onDragOver={e => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDrag(false)
        }}
        onDrop={onDrop}
      >
        {items.length === 0 && !loading ? (
          <div className="empty">
            没有符合条件的图片。
            <br />
            把图片拖到这里，或点击顶部「上传图片」。
          </div>
        ) : (
          <div className={`grid${drag ? ' drop-active' : ''}`} style={{ ['--cell' as string]: `${cell}px` }}>
            <ImageGrid />
          </div>
        )}
      </div>

      <div className="pager">
        <button className="btn sm" disabled={filter.page <= 1} onClick={() => setFilter({ page: filter.page - 1 })}>
          上一页
        </button>
        <span>
          {filter.page} / {pages} 页 · 共 {total} 张
        </span>
        <button className="btn sm" disabled={filter.page >= pages} onClick={() => setFilter({ page: filter.page + 1 })}>
          下一页
        </button>
      </div>
      </div>
      <DetailPanel />
    </>
  )
}
