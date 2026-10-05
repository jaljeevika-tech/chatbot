import { Play, Pause, Square, SkipBack, SkipForward, RotateCcw, RotateCw } from 'lucide-react'
import type { SegmentPlayer } from './useSegmentPlayer'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

function fmt(t: number) {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  player: SegmentPlayer
  /** Accent colour for the play button + progress fill. */
  accent: string
  /** Icon colour on top of the accent. */
  accentInk: string
  disabled?: boolean
  /** "part" / "line" — used in the prev/next tooltips. */
  segmentLabel: string
}

/** Transport bar for useSegmentPlayer: prev/−10s/play-pause/+10s/next, stop,
 *  scrubber, elapsed/total time and speed. Keyboard: Space/K play-pause,
 *  ←/→ ±10s, J/L ±10s, Shift+←/→ prev/next segment (when the bar is focused). */
export function PlayerControls({ player, accent, accentInk, disabled, segmentLabel }: Props) {
  const off = disabled || !player.ready

  function onKeyDown(e: React.KeyboardEvent) {
    if (off || (e.target as HTMLElement).tagName === 'SELECT') return
    const k = e.key.toLowerCase()
    if (k === ' ' || k === 'k') { e.preventDefault(); player.toggle() }
    else if (e.key === 'ArrowLeft'  && e.shiftKey) { e.preventDefault(); player.prevSegment() }
    else if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); player.nextSegment() }
    else if (e.key === 'ArrowLeft'  || k === 'j') { e.preventDefault(); player.skip(-10) }
    else if (e.key === 'ArrowRight' || k === 'l') { e.preventDefault(); player.skip(10) }
  }

  const iconBtn = 'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all disabled:opacity-30 hover:bg-white/10'

  return (
    <div className="flex flex-col gap-1.5 w-full outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] tabular-nums text-white/60 w-8 text-right">{fmt(player.time)}</span>
        <input
          type="range" min={0} max={player.duration || 0} step={0.1} value={player.time}
          disabled={off}
          onChange={e => player.seek(Number(e.target.value))}
          aria-label="Seek"
          className="flex-1 h-1 cursor-pointer disabled:cursor-default"
          style={{ accentColor: accent }}
        />
        <span className="text-[10px] tabular-nums text-white/60 w-8">{fmt(player.duration)}</span>
      </div>

      <div className="flex items-center gap-1">
        <button onClick={player.prevSegment} disabled={off} className={iconBtn} title={`Previous ${segmentLabel} (Shift+←)`} aria-label={`Previous ${segmentLabel}`}>
          <SkipBack className="w-3.5 h-3.5 text-white" />
        </button>
        <button onClick={() => player.skip(-10)} disabled={off} className={`${iconBtn} relative`} title="Back 10s (←)" aria-label="Back 10 seconds">
          <RotateCcw className="w-4 h-4 text-white" />
          <span className="absolute text-[7px] font-bold text-white" style={{ top: 10 }}>10</span>
        </button>
        <button onClick={player.toggle} disabled={off}
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all"
          style={{ background: off ? 'rgba(255,255,255,0.07)' : accent }}
          title={player.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={player.playing ? 'Pause' : 'Play'}
        >
          {player.playing
            ? <Pause className="w-4 h-4" style={{ color: accentInk }} />
            : <Play  className="w-4 h-4" style={{ color: off ? '#6B7280' : accentInk }} />}
        </button>
        <button onClick={() => player.skip(10)} disabled={off} className={`${iconBtn} relative`} title="Forward 10s (→)" aria-label="Forward 10 seconds">
          <RotateCw className="w-4 h-4 text-white" />
          <span className="absolute text-[7px] font-bold text-white" style={{ top: 10 }}>10</span>
        </button>
        <button onClick={player.nextSegment} disabled={off} className={iconBtn} title={`Next ${segmentLabel} (Shift+→)`} aria-label={`Next ${segmentLabel}`}>
          <SkipForward className="w-3.5 h-3.5 text-white" />
        </button>
        <button onClick={player.stop} disabled={off || (!player.playing && player.time === 0)} className={iconBtn} title="Stop" aria-label="Stop">
          <Square className="w-3 h-3 text-white" />
        </button>

        <select
          value={player.rate} onChange={e => player.setRate(Number(e.target.value))} disabled={off}
          className="ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-semibold outline-none cursor-pointer disabled:opacity-30"
          style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none' }}
          title="Playback speed" aria-label="Playback speed"
        >
          {SPEEDS.map(s => <option key={s} value={s} style={{ color: '#000' }}>{s}×</option>)}
        </select>
      </div>
    </div>
  )
}
