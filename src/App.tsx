import { useEffect, useState, type KeyboardEvent } from 'react'
import { searchWords, type SearchResponse } from './api/search'
import { ResultList } from './components/ResultList'
import './App.css'

const LANGUAGES = [
  { code: '', label: '全部' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
]

const LIMIT = 30

function readInitialState() {
  const params = new URLSearchParams(window.location.search)
  return {
    q: params.get('q') ?? '',
    lang: params.get('lang') ?? '',
  }
}

function keyOf(term: string, lang: string) {
  return `${term}\u0000${lang}`
}

function App() {
  const [initial] = useState(readInitialState)
  const [query, setQuery] = useState(initial.q)
  const [lang, setLang] = useState(initial.lang)
  const [debouncedQuery, setDebouncedQuery] = useState(initial.q)
  const [result, setResult] = useState<{
    key: string
    res: SearchResponse
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const [active, setActive] = useState(0)

  // Debounce the input before hitting the API.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  // Fetch results, aborting stale requests.
  useEffect(() => {
    const term = debouncedQuery.trim()
    if (!term) return

    const key = keyOf(term, lang)
    const controller = new AbortController()

    searchWords({ q: term, lang, limit: LIMIT, signal: controller.signal })
      .then((res) => {
        setResult({ key, res })
        setFailure(null)
        setActive(0)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setFailure({
          key,
          message: err instanceof Error ? err.message : '未知错误',
        })
      })

    return () => controller.abort()
  }, [debouncedQuery, lang])

  // Keep the URL shareable.
  useEffect(() => {
    const term = debouncedQuery.trim()
    const params = new URLSearchParams()
    if (term) params.set('q', term)
    if (lang) params.set('lang', lang)
    const search = params.toString()
    window.history.replaceState(
      null,
      '',
      search ? `?${search}` : window.location.pathname,
    )
  }, [debouncedQuery, lang])

  const term = debouncedQuery.trim()
  const key = term ? keyOf(term, lang) : ''
  const hasResult = result?.key === key
  const hasFailure = failure?.key === key
  const items = hasResult && result ? result.res.items : []

  const showPrompt = query.trim() === ''
  const showLoading = !showPrompt && !hasFailure && !hasResult

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (items.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, items.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    }
  }

  return (
    <main className="app">
      <header className="app__header">
        <h1>fishDict</h1>
        <p className="app__sub">多语言词典 · 中文 / English / 日本語 / 한국어</p>
      </header>

      <input
        className="search__input"
        type="search"
        placeholder="输入要查的词…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />

      <div className="tabs">
        {LANGUAGES.map((item) => (
          <button
            key={item.code || 'all'}
            type="button"
            className={item.code === lang ? 'tab tab--active' : 'tab'}
            onClick={() => setLang(item.code)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="results">
        {showPrompt && <p className="hint">输入关键词开始搜索</p>}
        {showLoading && <p className="hint">搜索中…</p>}
        {hasFailure && failure && (
          <p className="hint hint--error">出错了：{failure.message}</p>
        )}
        {hasResult && result && items.length === 0 && (
          <p className="hint">没有找到「{result.res.q}」</p>
        )}
        {hasResult && result && items.length > 0 && (
          <>
            <p className="hint">
              共 {result.res.total} 条，显示前 {items.length} 条
            </p>
            <ResultList items={items} query={result.res.q} activeIndex={active} />
          </>
        )}
      </section>
    </main>
  )
}

export default App
