# Data sources & licenses

## CC-CEDICT (`public.hsk.senses`)

The English definitions stored in `public.hsk.senses` come from **CC-CEDICT**,
published by MDBG, and are licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

- https://cc-cedict.org/
- https://www.mdbg.net/chinese/dictionary?page=cc-cedict

`db/import-cedict.mjs` downloads the dictionary, matches it against the HSK
words in `db/dump.sql`, and writes the definitions grouped by pinyin.

Because the definitions are CC BY-SA 4.0, any redistribution of the data in
`hsk.senses` must keep the same license and attribute CC-CEDICT / MDBG.

## HSK word list (`public.hsk`, `public.words` categories)

HSK 3.0 vocabulary list (levels 1–7).
