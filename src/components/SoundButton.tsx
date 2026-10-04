import { useEffect, useRef, useState } from 'react'

// Only one pronunciation plays at a time.
let current: HTMLAudioElement | null = null

function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Plays a random one of `sources` on every click. If a voice is missing the
 * word it falls through to the next candidate, so we always play the ones
 * that exist.
 */
export function SoundButton({ sources }: { sources: string[] }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (current === audioRef.current) current = null
    }
  }, [])

  function playFrom(order: string[]) {
    let i = 0
    const attempt = () => {
      if (i >= order.length) {
        setPlaying(false)
        return
      }
      const audio = new Audio(order[i++])
      audioRef.current = audio
      if (current && current !== audio) {
        current.pause()
        current.currentTime = 0
      }
      current = audio
      let advanced = false
      const advance = () => {
        if (advanced) return
        advanced = true
        attempt()
      }
      audio.addEventListener('play', () => setPlaying(true))
      audio.addEventListener('pause', () => setPlaying(false))
      audio.addEventListener('ended', () => setPlaying(false))
      audio.addEventListener('error', advance)
      void audio.play().catch(advance)
    }
    attempt()
  }

  function toggle() {
    const audio = audioRef.current
    if (audio && !audio.paused) {
      audio.pause()
      return
    }
    if (sources.length > 0) playFrom(shuffled(sources))
  }

  return (
    <button
      type="button"
      className={playing ? 'result__sound result__sound--on' : 'result__sound'}
      onClick={toggle}
      aria-label={playing ? '暂停发音' : '播放发音'}
      title={playing ? '暂停' : '发音'}
    >
      {playing ? '⏸' : '🔊'}
    </button>
  )
}
