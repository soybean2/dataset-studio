import { useState, type JSX } from 'react'
import { useStore } from '../store'

const splitList = (v: string): string[] =>
  v
    .split(/[,，\n]/)
    .map(s => s.trim())
    .filter(Boolean)

export function SelectionBar(): JSX.Element | null {
  const { selected, clearSelection, selectAll, batchPatch, runTag, restore, remove, items, busy } = useStore()
  const [text, setText] = useState('')
  const ids = [...selected]
  if (!ids.length) return null

  const needText = (fn: (list: string[]) => void, label: string): void => {
    const list = splitList(text)
    if (!list.length) {
      window.alert(`请先在右侧输入${label}`)
      return
    }
    fn(list)
  }

  return (
    <div className="selection-bar">
      <strong>已选 {ids.length} 张</strong>
      <button className="btn sm" onClick={selectAll} disabled={busy !== null}>
        全选本页 ({items.length})
      </button>
      <button className="btn sm" onClick={clearSelection}>
        清空
      </button>
      <input
        className="field"
        style={{ width: 220 }}
        placeholder="标签用逗号分隔 / 描述文本"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <button className="btn sm" disabled={busy !== null} onClick={() => needText(list => void batchPatch({ addTags: list }), '要添加的标签')}>
        加标签
      </button>
      <button className="btn sm" disabled={busy !== null} onClick={() => needText(list => void batchPatch({ removeTags: list }), '要移除的标签')}>
        删标签
      </button>
      <button className="btn sm" disabled={busy !== null} onClick={() => (text.trim() ? void batchPatch({ appendCaption: text.trim() }) : window.alert('请先输入要追加的描述'))}>
        追加描述
      </button>
      <button className="btn sm" disabled={busy !== null} onClick={() => void runTag(ids)}>
        打标选中
      </button>
      <button className="btn sm" disabled={busy !== null} onClick={() => void batchPatch({ status: 'active' })}>
        设为可用
      </button>
      <button className="btn sm" disabled={busy !== null} onClick={() => void batchPatch({ status: 'excluded' })}>
        排除
      </button>
      <button
        className="btn sm"
        disabled={busy !== null}
        onClick={() => {
          if (!window.confirm(`将 ${ids.length} 张移入排除区？（可在「已排除」中恢复）`)) return
          void Promise.all(ids.map(id => remove(id, false)))
        }}
      >
        软删除
      </button>
      <button
        className="btn sm danger"
        disabled={busy !== null}
        onClick={() => {
          if (!window.confirm(`彻底删除 ${ids.length} 张图片文件与记录？此操作不可恢复。`)) return
          void Promise.all(ids.map(id => remove(id, true)))
        }}
      >
        彻底删除
      </button>
      <button
        className="btn sm"
        disabled={busy !== null}
        onClick={() => {
          if (!window.confirm(`恢复 ${ids.length} 张为可用并锁定（不再被自动剔除）？`)) return
          void Promise.all(ids.map(id => restore(id)))
        }}
      >
        恢复并锁定
      </button>
    </div>
  )
}
