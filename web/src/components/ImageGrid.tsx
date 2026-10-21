import { memo, type JSX, type MouseEvent } from 'react'
import { STATUS_LABEL, THUMB_QUALITY_COLOR, type ImageDto } from '../api'
import { useStore } from '../store'

function Card({ img }: { img: ImageDto }): JSX.Element {
  const { selected, current, toggleSelect, setCurrent } = useStore()
  const isSel = selected.has(img.id)
  const isCur = current?.id === img.id

  const onClick = (e: MouseEvent): void => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      toggleSelect(img.id, e.shiftKey)
      return
    }
    setCurrent(img)
  }

  return (
    <div className={`card${isSel ? ' selected' : ''}${isCur ? ' current' : ''}`} onClick={onClick} title={`${img.fileName}\nShift/点击可多选`}>
      <img className="thumb" src={img.thumbUrl} alt={img.fileName} loading="lazy" decoding="async" />
      <span className="pick">{isSel ? '✓' : ''}</span>
      <span className="corner">
        {img.pinned ? <span className="badge pinned">锁定</span> : null}
        {img.status !== 'active' ? <span className={`badge ${img.status}`}>{STATUS_LABEL[img.status]}</span> : null}
      </span>
      <span className="qpill" style={{ position: 'absolute', bottom: 62, right: 6, color: THUMB_QUALITY_COLOR(img.quality) }}>
        {img.quality ?? '–'}
      </span>
      <div className="meta">
        <div className="name">{img.fileName}</div>
        <div className="row">
          <span>
            {img.width}×{img.height}
          </span>
          <span>·</span>
          <span>{img.tags.length ? `${img.tags.length} 标签` : img.tagStatus === 'pending' ? '未打标' : '无标签'}</span>
        </div>
      </div>
    </div>
  )
}

const MemoCard = memo(Card)

export function ImageGrid(): JSX.Element {
  const { items } = useStore()
  return (
    <>
      {items.map(img => (
        <MemoCard key={img.id} img={img} />
      ))}
    </>
  )
}
