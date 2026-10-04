import './env.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { pool } from './db.ts'

const app = new Hono()

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

type Sense = { en: string[] }
type KoreanSense = {
  en: string
  ko: string
  zh: string
  en_def: string
  zh_def: string
}

/** Escape LIKE wildcards so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal_error' }, 500)
})

// Pronunciation audio. $AUDIO_DIR holds per-language folders, e.g.
//   $AUDIO_DIR/ko/17287_ga-ge.wav  ->  GET /audio/ko/17287_ga-ge.wav
// Relative paths resolve against the repo root. Never hard-code a machine
// path here; set AUDIO_DIR in the gitignored .env instead.
const AUDIO_DIR = resolve(
  import.meta.dirname,
  '..',
  process.env.AUDIO_DIR ?? 'audio',
)
const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
}
app.use('/audio/*', async (c, next) => {
  await next()
  // hono/utils/mime has no .wav/.ogg entry, so serveStatic falls back to
  // application/octet-stream (which makes browsers download). Fix it up.
  if (c.res.headers.get('content-type') === 'application/octet-stream') {
    const ext = c.req.path.split('.').pop()?.toLowerCase() ?? ''
    if (AUDIO_TYPES[ext]) c.res.headers.set('content-type', AUDIO_TYPES[ext])
  }
})
app.use(
  '/audio/*',
  serveStatic({
    root: AUDIO_DIR,
    rewriteRequestPath: (path) => path.replace(/^\/audio/, ''),
  }),
)

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
    origin: string | null
    sound: string | null
    ko_senses: KoreanSense[] | null
    total: string
  }>(
    `SELECT w.lang, w.word, w.categories, h.senses, h.classifiers,
            k.origin, k.sound, k.senses AS ko_senses,
            count(*) OVER () AS total
       FROM words w
       LEFT JOIN LATERAL (
         SELECT senses, classifiers FROM hsk
          WHERE w.lang = 'zh' AND hsk.word = w.word
          LIMIT 1
       ) h ON true
       LEFT JOIN LATERAL (
         SELECT origin, sound, senses FROM korean
          WHERE w.lang = 'ko' AND korean.word = w.word
          LIMIT 1
       ) k ON true
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
      korean: r.ko_senses
        ? { origin: r.origin, sound: r.sound, senses: r.ko_senses }
        : null,
    })),
  })
})

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`fishDict API listening on http://localhost:${info.port}`)
})
