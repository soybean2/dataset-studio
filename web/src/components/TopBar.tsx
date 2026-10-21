import { useRef, useState, type JSX } from 'react'
import { useStore } from '../store'

export function TopBar(): JSX.Element {
  const { busy, connected, tagger, jobs, upload, importDir, runAnalyze, runTag, runDedup, setView } = useStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dirOpen, setDirOpen] = useState(false)
  const [dir, setDir] = useState('')

  const running = jobs.filter(j => j.status === 'running')
  const active = running[0]

  const onFiles = (files: FileList | null): void => {
    if (!files?.length) return
    void upload([...files])
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <header className="topbar">
      <span className="brand">Dataset Studio</span>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={e => onFiles(e.target.files)}
      />
      <button className="btn primary" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
        上传图片
      </button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => setDirOpen(v => !v)}>
        从目录导入
      </button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => void runAnalyze()}>
        重新分析
      </button>
      <button
        className="btn"
        disabled={Boolean(busy)}
        title={tagger.ok ? `打标服务已连接 (${tagger.mode ?? ''} ${tagger.model ?? ''})` : `打标服务不可用: ${tagger.error ?? '未连接'}`}
        onClick={() => void runTag()}
      >
        批量打标
      </button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => void runDedup()}>
        去重体检
      </button>
      <button className="btn" onClick={() => setView('export')}>
        导出
      </button>

      {dirOpen && (
        <span style={{ display: 'flex', gap: 6 }}>
          <input
            className="field"
            style={{ width: 260 }}
            placeholder="服务器上的绝对路径，如 /data/raw"
            value={dir}
            onChange={e => setDir(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && dir.trim()) {
                setDirOpen(false)
                void importDir(dir.trim())
              }
              if (e.key === 'Escape') setDirOpen(false)
            }}
          />
          <button
            className="btn sm"
            disabled={!dir.trim() || Boolean(busy)}
            onClick={() => {
              setDirOpen(false)
              void importDir(dir.trim())
            }}
          >
            导入
          </button>
        </span>
      )}

      <div className="spacer" />

      <div className="jobs">
        {active ? (
          <div className="job">
            <span className="spin" />
            <span style={{ flex: 1 }}>
              {active.message || active.kind} {active.total ? `${active.done}/${active.total}` : ''}
            </span>
            <span className="bar">
              <i style={{ width: `${active.total ? Math.round((active.done / active.total) * 100) : 100}%` }} />
            </span>
          </div>
        ) : busy ? (
          <div className="job">
            <span className="spin" />
            <span>{busy}</span>
          </div>
        ) : null}
      </div>

      <span className="dot" style={{ background: connected ? 'var(--good)' : 'var(--bad)' }} title={connected ? '事件流已连接' : '事件流断开'} />
      <span className="dot" style={{ background: tagger.ok ? 'var(--good)' : 'var(--muted)' }} title={tagger.ok ? `打标服务 ${tagger.model ?? ''}` : `打标服务不可用: ${tagger.error ?? ''}`} />
    </header>
  )
}
