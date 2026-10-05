#!/usr/bin/env node
// Imports English per-word data into public.english.
//
// Output: a SQL script on stdout to be piped into psql, e.g.
//   node db/import-english.mjs | docker compose exec -T db psql -U fishdict -d fishdict
//
// The table holds one row per English word:
//   word  text primary key
//   ipa   jsonb  { "us": "/ˈbæŋk/", "uk": "/bˈæŋk/" }  (keys omitted when absent)
//   sound text   audio filename, sha1('en:' + word)[:10] + '.mp3'
//   zh    text   ECDICT Chinese translation (verbatim, literal \n decoded)
//
// Pronunciations come from ipa-dict (MIT) and are stored verbatim; the US file
// marks stress at the syllable onset, the UK file marks it before the vowel.
//   https://github.com/open-dict-data/ipa-dict
// Translations come from ECDICT (MIT).
//   https://github.com/skywind3000/ECDICT
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dumpPath = join(here, 'dump.sql')
const IPA_SOURCES = {
  us: {
    file: join(here, 'ipa_en_US.txt'),
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt',
  },
  uk: {
    file: join(here, 'ipa_en_UK.txt'),
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt',
  },
}
const ECDICT_URL =
  'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
const ecdictPath = join(here, 'ecdict.csv')

for (const { file, url } of Object.values(IPA_SOURCES)) {
  if (existsSync(file)) continue
  process.stderr.write(`downloading ipa-dict -> ${file}\n`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}
if (!existsSync(ecdictPath)) {
  process.stderr.write(`downloading ECDICT -> ${ecdictPath}\n`)
  const res = await fetch(ECDICT_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(ecdictPath, Buffer.from(await res.arrayBuffer()))
}

// ---------------------------------------------------------------------------
// Word list: every English word, parsed from db/dump.sql (no DB needed)
// ---------------------------------------------------------------------------
function readEnglishWords(sql) {
  const lines = sql.split('\n')
  const header = lines.findIndex((l) => l.startsWith('COPY public.words ('))
  if (header < 0) throw new Error('COPY public.words block not found in dump.sql')
  const columns = lines[header]
    .slice(lines[header].indexOf('(') + 1, lines[header].indexOf(')'))
    .split(',')
    .map((c) => c.trim())
  const langIndex = columns.indexOf('lang')
  const wordIndex = columns.indexOf('word')
  if (langIndex < 0 || wordIndex < 0) {
    throw new Error('missing "lang"/"word" columns in words copy')
  }
  const words = []
  for (let i = header + 1; i < lines.length; i++) {
    if (lines[i] === '\\.') break
    const cells = lines[i].split('\t')
    if (cells[langIndex] === 'en' && cells[wordIndex]) words.push(cells[wordIndex])
  }
  return words
}

/** Read `word\t/ipa/` lines into a Map<word, value>. */
function parseIpa(path) {
  const map = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    map.set(line.slice(0, tab), line.slice(tab + 1))
  }
  return map
}

/** Parse one CSV record (no embedded newlines; ECDICT encodes them as \\n). */
function parseCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out
}

/** Load ECDICT `word -> translation`, plus a lowercase index for fallback. */
function parseEcdict(path) {
  const exact = new Map()
  const lower = new Map()
  const text = readFileSync(path, 'utf8')
  let start = text.indexOf('\n') + 1 // skip header
  for (const line of text.slice(start).split('\n')) {
    if (!line) continue
    const cells = parseCsvLine(line)
    const word = cells[0]
    const translation = cells[3]?.replace(/\\n/g, '\n').trim()
    if (!word || !translation) continue
    exact.set(word, translation)
    if (!lower.has(word.toLowerCase())) lower.set(word.toLowerCase(), translation)
  }
  return { exact, lower }
}

const ipa = { us: parseIpa(IPA_SOURCES.us.file), uk: parseIpa(IPA_SOURCES.uk.file) }
const ecdict = parseEcdict(ecdictPath)
const sound = (word) =>
  createHash('sha1').update(`en:${word}`).digest('hex').slice(0, 10) + '.mp3'

// ipa-dict keys are lowercase and ECDICT is inconsistently cased, so both use a
// case-insensitive fallback. A few words collide with a different word; those
// get an explicit value here.
const OVERRIDES = {
  IT: { us: '/ˌaɪˈti/', uk: '/ˌaɪˈti/', zh: 'abbr. 信息技术（Information Technology）' },
  Ms: { us: '/ˈmɪz/', uk: '/ˈmɪz/', zh: 'n. 女士' },
  BCE: { zh: 'abbr. 公元前（Before Common Era）' },
}

function lookup(dict, word) {
  if (dict.has(word)) return dict.get(word)
  const lower = word.toLowerCase()
  return lower !== word && dict.has(lower) ? dict.get(lower) : null
}

function lookupZh(word) {
  return ecdict.exact.get(word) ?? ecdict.lower.get(word.toLowerCase()) ?? null
}

const words = [...new Set(readEnglishWords(readFileSync(dumpPath, 'utf8')))]
const rows = words.map((word) => {
  const entry = {}
  const us = lookup(ipa.us, word)
  const uk = lookup(ipa.uk, word)
  if (us) entry.us = us
  if (uk) entry.uk = uk
  if (OVERRIDES[word]) {
    if (OVERRIDES[word].us) entry.us = OVERRIDES[word].us
    if (OVERRIDES[word].uk) entry.uk = OVERRIDES[word].uk
  }
  const zh = OVERRIDES[word]?.zh ?? lookupZh(word)
  return {
    word,
    ipa: Object.keys(entry).length > 0 ? JSON.stringify(entry) : null,
    sound: sound(word),
    zh,
  }
})

const noIpa = rows.filter((r) => !r.ipa).length
const noZh = rows.filter((r) => !r.zh).length

const escapeCopy = (value) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

process.stderr.write(
  `english words: ${words.length}; without ipa: ${noIpa}; without zh: ${noZh}\n`,
)

const out = []
out.push('BEGIN;')
out.push('DROP TABLE IF EXISTS public.english;')
out.push(
  'CREATE TABLE public.english (' +
    'word text PRIMARY KEY, ipa jsonb, zh text, sound text);',
)
// The per-word audio filename now lives in public.english only.
out.push('ALTER TABLE public.cet DROP COLUMN IF EXISTS sound;')
out.push('ALTER TABLE public.gaokao DROP COLUMN IF EXISTS sound;')
out.push('ALTER TABLE public.oxford DROP COLUMN IF EXISTS sound;')
out.push(
  'ALTER TABLE public.words DROP COLUMN IF EXISTS ipa_us, ' +
    'DROP COLUMN IF EXISTS ipa_uk;',
)
out.push(
  'CREATE TEMP TABLE _english (word text, ipa jsonb, zh text, sound text) ' +
    'ON COMMIT DROP;',
)
out.push('COPY _english (word, ipa, zh, sound) FROM stdin;')
for (const { word, ipa: json, zh, sound: snd } of rows) {
  out.push(
    `${escapeCopy(word)}\t${json ? escapeCopy(json) : '\\N'}\t` +
      `${zh ? escapeCopy(zh) : '\\N'}\t${snd}`,
  )
}
out.push('\\.')
out.push(
  'INSERT INTO public.english (word, ipa, zh, sound) ' +
    'SELECT word, ipa, zh, sound FROM _english e ' +
    'ON CONFLICT (word) DO UPDATE SET ipa = EXCLUDED.ipa, ' +
    'zh = EXCLUDED.zh, sound = EXCLUDED.sound;',
)
out.push(
  "COMMENT ON COLUMN public.english.ipa IS " +
    "'US/UK IPA from ipa-dict (MIT), stored verbatim; data (c) ipa-dict contributors';",
)
out.push(
  "COMMENT ON COLUMN public.english.sound IS " +
    "'Audio filename: sha1(''en:'' || word)[:10] || ''.mp3''';",
)
out.push(
  "COMMENT ON COLUMN public.english.zh IS " +
    "'Chinese translation from ECDICT (MIT), stored verbatim';",
)
out.push('COMMIT;')

process.stdout.write(out.join('\n') + '\n')
