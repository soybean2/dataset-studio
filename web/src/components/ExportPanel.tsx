import { useEffect, useState, type JSX } from 'react'
import { api, type JobDto } from '../api'
import { useStore } from '../store'
import { formatTime } from '../util'

export function ExportPanel(): JSX.Element {
  const { counts, jobs, pushToast, busy, refreshCounts } = useStore()
  const [targetDir, setTargetDir] = useState('')
  const [append, setAppend] = useState(true)
  const [exports, setExports] = useState<{ name: string; path: string; zipPath: string | null; mtime: number }[]>([])
  const [lastOut, setLastOut] = useState<string | null>(null)

  const load = (): void => {
    api
      .exports()
      .then(r => setExports(r.exports))
      .catch(e => pushToast(String(e), 'error'))
  }

  useEffect(load, [pushToast])

  useEffect(() => {
    const done = jobs.find(j => j.kind === 'export' && j.status !== 'running')
    if (done) {
      load()
      void refreshCounts()
    }
  }, [jobs, refreshCounts])

  const active = jobs.find(j => j.kind === 'export' && j.status === 'running')
  const exportable = counts.active ?? 0

  const run = async (): Promise<void> => {
    try {
      const r = await api.export(targetDir.trim(), append)
      if (r.error) {
        pushToast(r.error, 'error')
        return
      }
      setLastOut(r.outDir)
      pushToast('导出任务已开始', 'info')
    } catch (e) {
      pushToast(String(e), 'error')
    }
  }

  return (
    <div className="panel">
      <h2>导出训练集</h2>
      <p className="hint">
        仅导出状态为「可用」的 {exportable} 张图片。输出目录结构：<span className="mono">train/0001_name.jpg</span> +{' '}
        <span className="mono">train/0001_name.txt</span>（描述）+ <span className="mono">metadata.json</span>，并打包同名 ZIP。
      </p>

      <div className="section" style={{ maxWidth: 720, marginBottom: 20 }}>
        <div className="form">
          <label htmlFor="targetDir">输出目录（可选）</label>
          <input
            id="targetDir"
            className="field"
            placeholder="留空则用服务器默认 exports/ 目录"
            value={targetDir}
            onChange={e => setTargetDir(e.target.value)}
          />
          <label htmlFor="append">追加模式</label>
          <span className="switch">
            <input id="append" type="checkbox" checked={append} onChange={e => setAppend(e.target.checked)} />
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              不清空已有文件，编号从现有最大值继续（关闭则先清空该目录）
            </span>
          </span>
          <div className="note">
            输出目录若填写，必须位于服务器 <span className="mono">IMPORT_ROOT</span> 允许范围内（未设置时不限制）。
          </div>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy !== null || exportable === 0 || Boolean(active)} onClick={() => void run()}>
            {active ? '导出中…' : '开始导出'}
          </button>
          {exportable === 0 ? <span style={{ color: 'var(--muted)', fontSize: 12.5, alignSelf: 'center' }}>当前没有可导出的图片</span> : null}
        </div>
        {active ? (
          <div className="job" style={{ maxWidth: 420 }}>
            <span className="spin" />
            <span style={{ flex: 1 }}>
              {active.message} {active.done}/{active.total}
            </span>
            <span className="bar">
              <i style={{ width: `${active.total ? Math.round((active.done / active.total) * 100) : 0}%` }} />
            </span>
          </div>
        ) : null}
        {lastOut ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            最近输出：<span className="mono">{lastOut}</span>
          </div>
        ) : null}
      </div>

      <div className="section">
        <h3>导出历史</h3>
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={load}>
          刷新
        </button>
        {exports.length === 0 ? <div className="empty">还没有导出记录。</div> : null}
        <div className="exports">
          {exports.map(e => (
            <div className="export-row" key={e.path}>
              <span className="grow mono" title={e.path}>
                {e.name}
              </span>
              <span style={{ color: 'var(--muted)' }}>{formatTime(e.mtime)}</span>
              {e.zipPath ? <span className="badge active">ZIP</span> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="section" style={{ marginTop: 20 }}>
        <h3>最近任务</h3>
        <div className="exports">
          {jobs.length === 0 ? <div className="empty">暂无任务。</div> : null}
          {jobs.map((j: JobDto) => (
            <div className="export-row" key={j.id}>
              <span style={{ width: 62 }}>{j.kind}</span>
              <span style={{ width: 62, color: j.status === 'done' ? 'var(--good)' : j.status === 'failed' ? 'var(--bad)' : 'var(--muted)' }}>
                {j.status}
              </span>
              <span className="grow">{j.error ?? j.message}</span>
              <span style={{ color: 'var(--muted)' }}>
                {j.done}/{j.total}
              </span>
              <span style={{ color: 'var(--muted)' }}>{formatTime(j.created_at)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
