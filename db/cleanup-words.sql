-- One-off cleanup of the English word list.
--
-- 1. Remove misspellings that were expanded from cet.derivatives.
-- 2. Fix the source cet.derivatives arrays.
-- 3. Normalize spelling: apostrophes -> ASCII, merge/exclude accent variants.
-- 4. Drop the multi-word "a, an" entry.
--
-- Run once against the live DB, then refresh db/dump.sql with `npm run db:dump`.

BEGIN;

-- 1. misspellings ---------------------------------------------------------
DELETE FROM words
 WHERE lang = 'en' AND word IN ('connecxion', 'honourary', 'instalation');

-- 2. fix cet.derivatives --------------------------------------------------
UPDATE cet SET derivatives = array_remove(derivatives, 'connecxion')
 WHERE 'connecxion' = ANY (derivatives);
UPDATE cet SET derivatives = array_remove(derivatives, 'honourary')
 WHERE 'honourary' = ANY (derivatives);
UPDATE cet SET derivatives = array_remove(derivatives, 'instalation')
 WHERE 'instalation' = ANY (derivatives);

-- 3a. apostrophe: o’clock -> o'clock --------------------------------------
-- merge the two words-table rows, unioning categories
UPDATE words w
   SET categories = ARRAY(
         SELECT DISTINCT c FROM unnest(w.categories || w2.categories) AS c
          ORDER BY c)
  FROM words w2
 WHERE w.lang = 'en' AND w.word = 'o''clock'
   AND w2.lang = 'en' AND w2.word = 'o’clock';
DELETE FROM words WHERE lang = 'en' AND word = 'o’clock';

UPDATE gaokao SET word = 'o''clock', sound = '368f35f265.mp3'
 WHERE word = 'o’clock';
UPDATE oxford SET word = 'o''clock', sound = '368f35f265.mp3'
 WHERE word = 'o’clock';

-- 3b. accents: café -> cafe, cliché -> cliche (résumé is a distinct word,
--     left untouched) ------------------------------------------------------
UPDATE words w
   SET categories = ARRAY(
         SELECT DISTINCT c FROM unnest(w.categories || w2.categories) AS c
          ORDER BY c)
  FROM words w2
 WHERE w.lang = 'en' AND w.word = 'cafe'
   AND w2.lang = 'en' AND w2.word = 'café';
DELETE FROM words WHERE lang = 'en' AND word = 'café';
UPDATE gaokao SET word = 'cafe', sound = 'f006f02033.mp3' WHERE word = 'café';

UPDATE words SET word = 'cliche' WHERE lang = 'en' AND word = 'cliché';
UPDATE cet   SET word = 'cliche', sound = '68b0b0cc93.mp3' WHERE word = 'cliché';

-- 3c. drop the "a, an" entry ---------------------------------------------
DELETE FROM words  WHERE lang = 'en' AND word = 'a, an';
DELETE FROM oxford WHERE word = 'a, an';

COMMIT;
