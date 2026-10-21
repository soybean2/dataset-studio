import { useEffect, type JSX } from 'react'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { Gallery } from './components/Gallery'
import { DedupPanel } from './components/DedupPanel'
import { StatsPanel } from './components/StatsPanel'
import { ExportPanel } from './components/ExportPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Toasts } from './components/Toasts'

export function App(): JSX.Element {
  const { view, stepCurrent, setCurrent, clearSelection } = useStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === 'ArrowRight') stepCurrent(1)
      else if (e.key === 'ArrowLeft') stepCurrent(-1)
      else if (e.key === 'Escape') {
        setCurrent(null)
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearSelection, setCurrent, stepCurrent])

  return (
    <div className="app">
      <TopBar />
      <Sidebar />
      <div className="main">
        {view === 'gallery' && <Gallery />}
        {view === 'dedup' && <DedupPanel />}
        {view === 'stats' && <StatsPanel />}
        {view === 'export' && <ExportPanel />}
        {view === 'settings' && <SettingsPanel />}
      </div>
      <Toasts />
    </div>
  )
}
