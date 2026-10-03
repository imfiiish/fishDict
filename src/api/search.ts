export type SearchResponse = {
  lang: string | null
  q: string
  total: number
  items: { lang: string; word: string }[]
}

export async function searchWords({
  q,
  lang,
  limit,
  signal,
}: {
  q: string
  lang?: string
  limit?: number
  signal?: AbortSignal
}): Promise<SearchResponse> {
  const params = new URLSearchParams({ q })
  if (lang) params.set('lang', lang)
  if (limit) params.set('limit', String(limit))

  const res = await fetch(`/api/search?${params.toString()}`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  return (await res.json()) as SearchResponse
}
