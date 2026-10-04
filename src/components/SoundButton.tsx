import { useEffect, useRef, useState } from 'react'

// Only one pronunciation plays at a time.
let current: HTMLAudioElement | null = null

export function SoundButton({ src }: { src: string }) {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      if (current === audioRef.current) current = null
    }
  }, [])

  function getAudio() {
    if (!audioRef.current) {
      const audio = new Audio(src)
      audio.addEventListener('play', () => setPlaying(true))
      audio.addEventListener('pause', () => setPlaying(false))
      audio.addEventListener('ended', () => setPlaying(false))
      audio.addEventListener('error', () => setPlaying(false))
      audioRef.current = audio
    }
    return audioRef.current
  }

  function toggle() {
    const audio = getAudio()
    if (!audio.paused) {
      audio.pause()
      return
    }
    if (current && current !== audio) {
      current.pause()
      current.currentTime = 0
    }
    current = audio
    if (audio.ended) audio.currentTime = 0
    void audio.play().catch(() => setPlaying(false))
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
