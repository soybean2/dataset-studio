import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  type BatchPatch,
  type ImageDto,
  type ImageStatus,
  type JobDto,
  type ListQuery,
  type TaggerHealth
} from './api'

export type View = 'gallery' | 'dedup' | 'stats' | 'export' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'ok' | 'error'
  text: string
}

export interface Filter extends Required<Pick<ListQuery, 'status' | 'q' | 'tag' | 'tagStatus' | 'sort' | 'page' | 'pageSize'>> {
  groupId: string
  minQuality?: number
  maxQuality?: number
}

const DEFAULT_FILTER: Filter = {
  status: 'all',
  q: '',
  tag: '',
  tagStatus: '',
  groupId: '',
  sort: 'newest',
  page: 1,
  pageSize: 60,
  minQuality: undefined,
  maxQuality: undefined
}

interface Store {
  view: View
  setView: (v: View) => void
  counts: Record<string, number>
  filter: Filter
  setFilter: (patch: Partial<Filter>) => void
  items: ImageDto[]
  total: number
  loading: boolean
  error: string | null
  selected: Set<string>
  toggleSelect: (id: string, range?: boolean) => void
  selectOnly: (id: string) => void
  clearSelection: () => void
  selectAll: () => void
  current: ImageDto | null
  setCurrent: (img: ImageDto | null) => void
  stepCurrent: (delta: number) => void
  jobs: JobDto[]
  tagger: TaggerHealth
  toasts: Toast[]
  pushToast: (text: string, kind?: Toast['kind']) => void
  busy: string | null
  upload: (files: File[]) => Promise<void>
  importDir: (path: string) => Promise<void>
  runAnalyze: (ids?: string[]) => Promise<void>
  runTag: (ids?: string[]) => Promise<void>
  runDedup: () => Promise<void>
  patchImage: (id: string, patch: Partial<Pick<ImageDto, 'caption' | 'tags' | 'status' | 'pinned'>>) => Promise<void>
  batchPatch: (patch: Omit<BatchPatch, 'ids'>, ids?: string[]) => Promise<void>
  restore: (id: string) => Promise<void>
  remove: (id: string, hard: boolean) => Promise<void>
  refresh: () => Promise<void>
  refreshCounts: () => Promise<void>
  reloadCurrent: (id: string) => Promise<void>
  connected: boolean
}

const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用')
  return ctx
}

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [view, setView] = useState<View>('gallery')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [filter, setFilterState] = useState<Filter>(DEFAULT_FILTER)
  const [items, setItems] = useState<ImageDto[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [current, setCurrentState] = useState<ImageDto | null>(null)
  const [jobs, setJobs] = useState<JobDto[]>([])
  const [tagger, setTagger] = useState<TaggerHealth>({ ok: false })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const lastClickRef = useRef<string | null>(null)
  const toastSeq = useRef(0)
  const itemsRef = useRef<ImageDto[]>([])
  itemsRef.current = items

  const pushToast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq.current
    setToasts(t => [...t.slice(-4), { id, kind, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])

  const setFilter = useCallback((patch: Partial<Filter>) => {
    setFilterState(f => ({ ...f, ...patch, page: patch.page ?? 1 }))
  }, [])

  const refreshCounts = useCallback(async () => {
    try {
      const h = await api.health()
      setCounts(h.counts)
      setTagger(h.tagger)
    } catch {
      /* 后端未就绪时静默 */
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listImages(filter)
      setItems(res.items)
      setTotal(res.total)
      await refreshCounts()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filter, refreshCounts])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reloadCurrent = useCallback(async (id: string) => {
    try {
      setCurrentState(await api.getImage(id))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setCurrentState(null)
    }
  }, [])

  const setCurrent = useCallback((img: ImageDto | null) => {
    setCurrentState(img)
    if (img) void reloadCurrent(img.id)
  }, [reloadCurrent])

  const stepCurrent = useCallback(
    (delta: number) => {
      const list = itemsRef.current
      if (!list.length) return
      const idx = current ? list.findIndex(i => i.id === current.id) : -1
      const next = list[Math.min(list.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta))]
      if (next) setCurrent(next)
    },
    [current, setCurrent]
  )

  const toggleSelect = useCallback((id: string, range = false) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (range && lastClickRef.current && lastClickRef.current !== id) {
        const list = itemsRef.current
        const a = list.findIndex(i => i.id === lastClickRef.current)
        const b = list.findIndex(i => i.id === id)
        if (a >= 0 && b >= 0) {
          for (const item of list.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(item.id)
          lastClickRef.current = id
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      lastClickRef.current = id
      return next
    })
  }, [])

  const selectOnly = useCallback((id: string) => {
    setSelected(new Set([id]))
    lastClickRef.current = id
  }, [])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
    lastClickRef.current = null
  }, [])

  const selectAll = useCallback(() => {
    setSelected(new Set(itemsRef.current.map(i => i.id)))
  }, [])

  const trackJob = useCallback((jobId: string) => {
    void api
      .job(jobId)
      .then(job => setJobs(list => [job, ...list.filter(j => j.id !== job.id)].slice(0, 8)))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refresh()
      }, 400)
    }
    const onImage = (e: MessageEvent<string>): void => {
      const dto = JSON.parse(e.data) as ImageDto
      setItems(list => {
        const idx = list.findIndex(i => i.id === dto.id)
        if (idx < 0) return list
        const copy = [...list]
        copy[idx] = dto
        return copy
      })
      setCurrentState(cur => (cur && cur.id === dto.id ? dto : cur))
      void refreshCounts()
    }
    const onJob = (e: MessageEvent<string>): void => {
      const job = JSON.parse(e.data) as JobDto
      setJobs(list => [job, ...list.filter(j => j.id !== job.id)].slice(0, 8))
      if (job.status === 'done') pushToast(`${job.message || job.kind} 完成`, 'ok')
      if (job.status === 'failed') pushToast(`${job.kind} 失败: ${job.error ?? job.message}`, 'error')
      if (job.status !== 'running') scheduleRefresh()
    }
    const onGeneric = (): void => scheduleRefresh()
    es.addEventListener('image', onImage as EventListener)
    es.addEventListener('job', onJob as EventListener)
    for (const name of ['dedup', 'import', 'export']) es.addEventListener(name, onGeneric as EventListener)
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      es.close()
    }
  }, [pushToast, refresh, refreshCounts])

  const wrap = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label)
      try {
        await fn()
      } catch (e) {
        pushToast(e instanceof ApiError ? e.message : String(e), 'error')
      } finally {
        setBusy(null)
      }
    },
    [pushToast]
  )

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      await wrap(`上传 ${files.length} 个文件`, async () => {
        const res = await api.upload(files)
        if (res.jobId) trackJob(res.jobId)
        if (res.tagJobId) trackJob(res.tagJobId)
        pushToast(`导入 ${res.imported} 张，跳过 ${res.skipped} 张${res.errors.length ? `，失败 ${res.errors.length}` : ''}`, res.imported ? 'ok' : 'info')
        for (const err of res.errors.slice(0, 3)) pushToast(err, 'error')
        await refresh()
      })
    },
    [pushToast, refresh, trackJob, wrap]
  )

  const importDir = useCallback(
    async (dir: string) => {
      await wrap('导入目录', async () => {
        const res = await api.importDir(dir)
        if (res.jobId) trackJob(res.jobId)
        if (res.tagJobId) trackJob(res.tagJobId)
        pushToast(`目录导入 ${res.imported} 张，跳过 ${res.skipped} 张`, res.imported ? 'ok' : 'info')
        for (const err of res.errors.slice(0, 3)) pushToast(err, 'error')
        await refresh()
      })
    },
    [pushToast, refresh, trackJob, wrap]
  )

  const runAnalyze = useCallback(
    async (ids?: string[]) => {
      await wrap('分析', async () => {
        const r = await api.analyze(ids)
        trackJob(r.jobId)
        pushToast('已开始分析', 'info')
      })
    },
    [pushToast, trackJob, wrap]
  )

  const runTag = useCallback(
    async (ids?: string[]) => {
      await wrap('打标', async () => {
        const health = await api.taggerHealth()
        if (!health.ok) {
          pushToast(`打标服务不可用: ${health.error ?? '未连接'}（可在设置中检查地址）`, 'error')
          return
        }
        const r = await api.tag(ids)
        trackJob(r.jobId)
        pushToast('已开始打标', 'info')
      })
    },
    [pushToast, trackJob, wrap]
  )

  const runDedup = useCallback(async () => {
    await wrap('去重', async () => {
      const s = await api.runDedup()
      pushToast(`扫描 ${s.scanned} 张：近似组 ${s.groups}，重复 ${s.duplicates}，低质 ${s.lowQuality}`, 'ok')
      await refresh()
    })
  }, [pushToast, refresh, wrap])

  const patchImage = useCallback(
    async (id: string, patch: Partial<Pick<ImageDto, 'caption' | 'tags' | 'status' | 'pinned'>>) => {
      try {
        const dto = await api.patchImage(id, patch)
        setItems(list => list.map(i => (i.id === dto.id ? dto : i)))
        setCurrentState(cur => (cur && cur.id === dto.id ? dto : cur))
      } catch (e) {
        pushToast(e instanceof ApiError ? e.message : String(e), 'error')
      }
    },
    [pushToast]
  )

  const batchPatch = useCallback(
    async (patch: Omit<BatchPatch, 'ids'>, ids?: string[]) => {
      const target = ids ?? [...selected]
      if (!target.length) {
        pushToast('请先选择图片', 'error')
        return
      }
      await wrap('批量修改', async () => {
        const r = await api.batch({ ...patch, ids: target })
        pushToast(`已更新 ${r.updated} 张`, 'ok')
        await refresh()
        if (current && target.includes(current.id)) await reloadCurrent(current.id)
      })
    },
    [current, pushToast, refresh, reloadCurrent, selected, wrap]
  )

  const restore = useCallback(
    async (id: string) => {
      await wrap('恢复', async () => {
        const dto = await api.restore(id)
        setItems(list => list.map(i => (i.id === dto.id ? dto : i)))
        setCurrentState(cur => (cur && cur.id === dto.id ? dto : cur))
        await refreshCounts()
      })
    },
    [refreshCounts, wrap]
  )

  const remove = useCallback(
    async (id: string, hard: boolean) => {
      await wrap('删除', async () => {
        await api.remove(id, hard)
        setSelected(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setCurrentState(cur => (cur && cur.id === id ? null : cur))
        await refresh()
      })
    },
    [refresh, wrap]
  )

  const value = useMemo<Store>(
    () => ({
      view,
      setView,
      counts,
      filter,
      setFilter,
      items,
      total,
      loading,
      error,
      selected,
      toggleSelect,
      selectOnly,
      clearSelection,
      selectAll,
      current,
      setCurrent,
      stepCurrent,
      jobs,
      tagger,
      toasts,
      pushToast,
      busy,
      upload,
      importDir,
      runAnalyze,
      runTag,
      runDedup,
      patchImage,
      batchPatch,
      restore,
      remove,
      refresh,
      refreshCounts,
      reloadCurrent,
      connected
    }),
    [
      view, counts, filter, items, total, loading, error, selected, current, jobs, tagger, toasts, busy, connected,
      setFilter, toggleSelect, selectOnly, clearSelection, selectAll, setCurrent, stepCurrent, pushToast, upload,
      importDir, runAnalyze, runTag, runDedup, patchImage, batchPatch, restore, remove, refresh, refreshCounts, reloadCurrent
    ]
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export const STATUS_ORDER: (ImageStatus | 'all')[] = ['all', 'active', 'pending', 'dup', 'low_quality', 'excluded']
