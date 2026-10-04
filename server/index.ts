import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { pool } from './db.ts'

const app = new Hono()

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

type Sense = { en: string[] }

/** Escape LIKE wildcards so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal_error' }, 500)
})

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/languages', async (c) => {
  const { rows } = await pool.query<{ code: string; count: string }>(
    `SELECT l.code, count(w.*)::text AS count
       FROM languages l
       LEFT JOIN words w ON w.lang = l.code
      GROUP BY l.code
      ORDER BY l.code`,
  )
  return c.json(rows.map((r) => ({ code: r.code, count: Number(r.count) })))
})

app.get('/api/search', async (c) => {
  const lang = c.req.query('lang')?.trim() || null
  const q = c.req.query('q')?.trim() ?? ''
  const parsedLimit = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  if (!q) {
    return c.json({ lang, q, total: 0, items: [] })
  }

  const escaped = escapeLike(q)
  const { rows } = await pool.query<{
    lang: string
    word: string
    categories: string[]
    senses: Sense[] | null
    classifiers: string[] | null
    total: string
  }>(
    `SELECT w.lang, w.word, w.categories, h.senses, h.classifiers,
            count(*) OVER () AS total
       FROM words w
       LEFT JOIN LATERAL (
         SELECT senses, classifiers FROM hsk
          WHERE w.lang = 'zh' AND hsk.word = w.word
          LIMIT 1
       ) h ON true
      WHERE ($1::text IS NULL OR w.lang = $1)
        AND w.word ILIKE $2 ESCAPE '\\'
      ORDER BY
        CASE
          WHEN lower(w.word) = lower($3) THEN 0
          WHEN w.word ILIKE $4 ESCAPE '\\' THEN 1
          ELSE 2
        END,
        length(w.word),
        w.word
      LIMIT $5`,
    [lang, `%${escaped}%`, q, `${escaped}%`, limit],
  )

  return c.json({
    lang,
    q,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
    items: rows.map((r) => ({
      lang: r.lang,
      word: r.word,
      categories: r.categories,
      senses: r.senses,
      classifiers: r.classifiers ?? [],
    })),
  })
})

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`fishDict API listening on http://localhost:${info.port}`)
})
