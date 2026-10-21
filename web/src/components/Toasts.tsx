import type { JSX } from 'react'
import { useStore } from '../store'

export function Toasts(): JSX.Element {
  const { toasts } = useStore()
  return (
    <div className="toasts">
      {toasts.map(t => (
        <div className={`toast ${t.kind}`} key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
