// Pronunciation audio lives at $AUDIO_DIR/<lang>/<voice>/<file>, where
// <file> = sha1('<lang>:<word>')[:10] + extension. There is no voice picker:
// every play picks a random voice.
const VOICES: Record<string, string[]> = {
  zh: ['SeraphinaMultilingualNeural', 'HiuGaaiNeural', 'EmmaMultilingualNeural'],
  en: ['Emma', 'Sonia'],
  ja: ['Keita', 'Nanami'],
  ko: ['official'],
}

/** All candidate URLs for a word's pronunciation (one per voice). */
export function audioSources(lang: string, sound: string | null): string[] {
  if (!sound) return []
  const voices = VOICES[lang]
  if (!voices || voices.length === 0) return [`/audio/${lang}/${sound}`]
  return voices.map((voice) => `/audio/${lang}/${voice}/${sound}`)
}
