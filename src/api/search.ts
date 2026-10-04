export type Sense = {
  en: string[]
}

export type KoreanSense = {
  en: string
  ko: string
  zh: string
  en_def: string
  zh_def: string
}

export type KoreanEntry = {
  romanization: string | null
  origin: string | null
  sound: string | null
  senses: KoreanSense[]
}

export type Ipa = {
  us?: string
  uk?: string
}

export type SearchItem = {
  lang: string
  word: string
  categories: string[]
  senses: Sense[] | null
  classifiers: string[]
  sound: string | null
  ipa: Ipa | null
  korean: KoreanEntry | null
}

export type SearchResponse = {
  lang: string | null
  q: string
  total: number
  items: SearchItem[]
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
