import { useEffect, useState, type JSX } from 'react'
import { api, type DedupSummary, type Settings, type TaggerHealth } from '../api'
import { useStore } from '../store'

const NUM_FIELDS: { key: keyof Settings; label: string; hint: string; min?: number; max?: number; step?: number }[] = [
  { key: 'minQuality', label: '最低质量分', hint: '低于此分数的图片自动移入「低质量」隔离区', min: 0, max: 100, step: 1 },
  { key: 'minEdge', label: '最短边像素', hint: '宽或高小于此值视为分辨率不足', min: 0, max: 4096, step: 16 },
  { key: 'dedupThreshold', label: '近似图哈希距离', hint: '感知哈希汉明距离 ≤ 此值判为近似（0 完全相同，越大越宽松）', min: 0, max: 32, step: 1 },
  { key: 'taggerThreshold', label: '标签置信度阈值', hint: '低于此分数的标签被丢弃', min: 0, max: 1, step: 0.01 },
  { key: 'taggerMaxTags', label: '每张最多标签数', hint: '', min: 1, max: 100, step: 1 },
  { key: 'taggerBatch', label: '打标批大小', hint: '一次请求发送的图片数', min: 1, max: 32, step: 1 },
  { key: 'taggerConcurrency', label: '打标并发数', hint: 'CPU 推理建议 1', min: 1, max: 8, step: 1 },
  { key: 'jpgQuality', label: '导出 JPEG 质量', hint: '', min: 50, max: 100, step: 1 },
  { key: 'thumbSize', label: '缩略图长边', hint: '修改后需重新分析才会生效', min: 96, max: 1024, step: 16 }
]

export function SettingsPanel(): JSX.Element {
  const { pushToast, refresh, refreshCounts } = useStore()
  const [s, setS] = useState<Settings | null>(null)
  const [tagger, setTagger] = useState<TaggerHealth | null>(null)
  const [dedup, setDedup] = useState<DedupSummary | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .getSettings()
      .then(setS)
      .catch(e => pushToast(String(e), 'error'))
    api
      .taggerHealth()
      .then(setTagger)
      .catch(() => setTagger({ ok: false, error: '请求失败' }))
  }, [pushToast])

  if (!s) return <div className="panel"><div className="empty">加载中…</div></div>

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => setS(prev => (prev ? { ...prev, [key]: value } : prev))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await api.saveSettings(s)
      setS(r.settings)
      setDedup(r.dedup)
      pushToast(
        `已保存。按新阈值重新体检：扫描 ${r.dedup.scanned} 张，重复 ${r.dedup.duplicates}，低质 ${r.dedup.lowQuality}`,
        'ok'
      )
      await refresh()
      await refreshCounts()
    } catch (e) {
      pushToast(String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const recheck = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await api.taggerHealth()
      setTagger(r)
      pushToast(r.ok ? `打标服务已连接：${r.mode ?? ''} ${r.model ?? ''} ${r.device ?? ''}` : `打标服务不可用：${r.error ?? '未知错误'}`, r.ok ? 'ok' : 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel">
      <h2>设置</h2>
      <p className="hint">保存后会立刻按新的质量/去重阈值重新体检整个数据集（被锁定的图片不受影响）。</p>

      <div className="section" style={{ marginBottom: 22 }}>
        <h3>质量与去重</h3>
        <div className="form">
          {NUM_FIELDS.slice(0, 3).map(f => (
            <FieldNum key={f.key} f={f} s={s} set={set} />
          ))}
          <label htmlFor="autoQuarantine">自动隔离</label>
          <span className="switch">
            <input id="autoQuarantine" type="checkbox" checked={s.autoQuarantine} onChange={e => set('autoQuarantine', e.target.checked)} />
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>关闭后所有图片都保持「可用」，只标注不剔除</span>
          </span>
          <label htmlFor="autoAnalyze">上传后自动分析</label>
          <input id="autoAnalyze" type="checkbox" checked={s.autoAnalyze} onChange={e => set('autoAnalyze', e.target.checked)} />
          <label htmlFor="autoTag">上传后自动打标</label>
          <input id="autoTag" type="checkbox" checked={s.autoTag} onChange={e => set('autoTag', e.target.checked)} />
        </div>
      </div>

      <div className="section" style={{ marginBottom: 22 }}>
        <h3>打标服务</h3>
        <div className="form">
          <label htmlFor="taggerUrl">服务地址</label>
          <span style={{ display: 'flex', gap: 6 }}>
            <input id="taggerUrl" className="field" style={{ flex: 1 }} value={s.taggerUrl} onChange={e => set('taggerUrl', e.target.value)} />
            <button className="btn sm" disabled={saving} onClick={() => void recheck()}>
              测试连接
            </button>
          </span>
          <label htmlFor="taggerMode">推理模式</label>
          <select id="taggerMode" className="field" value={s.taggerMode} onChange={e => set('taggerMode', e.target.value)}>
            <option value="auto">auto（自动选择）</option>
            <option value="wd">wd（WD Tagger 标签）</option>
            <option value="blip">blip（BLIP 自然语言描述）</option>
            <option value="stub">stub（内置假数据，用于联调）</option>
          </select>
          <label htmlFor="triggerWord">触发词</label>
          <input
            id="triggerWord"
            className="field"
            placeholder="如 my_character，会写在每条描述最前面"
            value={s.triggerWord}
            onChange={e => set('triggerWord', e.target.value)}
          />
          <label htmlFor="taggerCaption">生成描述</label>
          <span className="switch">
            <input id="taggerCaption" type="checkbox" checked={s.taggerCaption} onChange={e => set('taggerCaption', e.target.checked)} />
            <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>用高置信度标签自动拼一条 caption</span>
          </span>
          {NUM_FIELDS.slice(3, 7).map(f => (
            <FieldNum key={f.key} f={f} s={s} set={set} />
          ))}
          <div className="note">
            当前状态：
            {tagger?.ok ? (
              <span style={{ color: 'var(--good)' }}>
                {' '}
                已连接 · {tagger.mode} · {tagger.model} · {tagger.device}
              </span>
            ) : (
              <span style={{ color: 'var(--bad)' }}> 不可用 · {tagger?.error ?? '未检测'}</span>
            )}
            <br />
            打标服务是独立的 Python sidecar，见 <span className="mono">tagger/README.md</span>；未启动时其它功能照常可用。
          </div>
        </div>
      </div>

      <div className="section" style={{ marginBottom: 22 }}>
        <h3>导出</h3>
        <div className="form">
          <label htmlFor="outputFormat">输出格式</label>
          <select id="outputFormat" className="field" value={s.outputFormat} onChange={e => set('outputFormat', e.target.value as Settings['outputFormat'])}>
            <option value="jpg">jpg</option>
            <option value="png">png</option>
          </select>
          {NUM_FIELDS.slice(7).map(f => (
            <FieldNum key={f.key} f={f} s={s} set={set} />
          ))}
        </div>
      </div>

      <div className="actions">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存并重新体检'}
        </button>
        <button
          className="btn"
          disabled={saving}
          onClick={() => {
            api
              .getSettings()
              .then(setS)
              .catch(e => pushToast(String(e), 'error'))
          }}
        >
          放弃修改
        </button>
      </div>

      {dedup ? (
        <p className="hint" style={{ marginTop: 12 }}>
          上次体检：扫描 {dedup.scanned} 张，近似组 {dedup.groups} 个，重复 {dedup.duplicates} 张，低质 {dedup.lowQuality} 张，状态变更 {dedup.changed} 条。
        </p>
      ) : null}
    </div>
  )
}

function FieldNum<K extends keyof Settings>({
  f,
  s,
  set
}: {
  f: { key: K; label: string; hint: string; min?: number; max?: number; step?: number }
  s: Settings
  set: <K2 extends keyof Settings>(key: K2, value: Settings[K2]) => void
}): JSX.Element {
  const value = s[f.key]
  const num = typeof value === 'number' ? value : Number(value)
  return (
    <>
      <label htmlFor={String(f.key)} title={f.hint}>
        {f.label}
      </label>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          id={String(f.key)}
          className="field"
          type="number"
          min={f.min}
          max={f.max}
          step={f.step}
          value={Number.isFinite(num) ? num : 0}
          onChange={e => set(f.key, Number(e.target.value) as Settings[K])}
        />
        {f.hint ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{f.hint}</span> : null}
      </span>
    </>
  )
}
