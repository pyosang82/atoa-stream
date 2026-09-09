// The player stage — a deep-space signal receiver.
// Every host utterance emits a pulse ring from the neutron-star core; sponsor
// events fire gold rings; rotating lighthouse beams give the "pulsar" signature.
// Canvas 2D, no deps. Pauses when the tab is hidden; respects reduced motion.
import { useEffect, useRef } from 'react'

interface StageProps {
  color: string
  speaking: boolean
  emotion?: string | null
  pulseKey: number | null   // change → emit a ring (host message ts)
  sponsorKey: number | null // change → emit a gold ring
  className?: string
}

interface Ring { r: number; alpha: number; gold: boolean; width: number }
interface Star { x: number; y: number; z: number; tw: number }

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [169, 112, 255]
}

export default function PulsarStage({ color, speaking, emotion, pulseKey, sponsorKey, className }: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ringsRef = useRef<Ring[]>([])
  const starsRef = useRef<Star[]>([])
  const speakingRef = useRef(speaking)
  const emotionRef = useRef(emotion)
  const colorRef = useRef<[number, number, number]>(hexToRgb(color))
  const lastPulse = useRef<number | null>(null)
  const lastSponsor = useRef<number | null>(null)

  speakingRef.current = speaking
  emotionRef.current = emotion
  useEffect(() => { colorRef.current = hexToRgb(color) }, [color])

  useEffect(() => {
    if (pulseKey !== null && pulseKey !== lastPulse.current) {
      lastPulse.current = pulseKey
      ringsRef.current.push({ r: 0, alpha: 0.55, gold: false, width: 2.5 })
    }
  }, [pulseKey])

  useEffect(() => {
    if (sponsorKey !== null && sponsorKey !== lastSponsor.current) {
      lastSponsor.current = sponsorKey
      ringsRef.current.push({ r: 0, alpha: 0.85, gold: true, width: 4 })
      ringsRef.current.push({ r: -18, alpha: 0.85, gold: true, width: 2.5 })
    }
  }, [sponsorKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let W = 0, H = 0, dpr = 1
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // seed starfield for this size
      const n = Math.floor((W * H) / 4200)
      starsRef.current = Array.from({ length: n }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        z: 0.3 + Math.random() * 0.7,
        tw: Math.random() * Math.PI * 2,
      }))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    let t = 0
    // no document.hidden gate — browsers already throttle rAF in hidden tabs
    const draw = () => {
      raf = requestAnimationFrame(draw)
      t += 0.016
      const [cr, cg, cb] = colorRef.current
      const cx = W / 2
      const cy = H * 0.32 // upper third — the caption band owns the bottom
      const speakingNow = speakingRef.current

      // ground
      ctx.clearRect(0, 0, W, H)
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75)
      bg.addColorStop(0, `rgba(${cr},${cg},${cb},0.10)`)
      bg.addColorStop(0.45, 'rgba(14,14,19,0.0)')
      ctx.fillStyle = '#0c0c12'
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)

      // starfield (twinkle, slight drift)
      for (const s of starsRef.current) {
        const tw = reduced ? 0.6 : 0.35 + 0.35 * Math.sin(t * 1.4 + s.tw)
        ctx.globalAlpha = tw * s.z
        ctx.fillStyle = '#cfd0e4'
        const size = s.z > 0.85 ? 1.6 : 1
        ctx.fillRect(s.x, s.y, size, size)
        if (!reduced) {
          s.x += 0.014 * s.z
          if (s.x > W) s.x = 0
        }
      }
      ctx.globalAlpha = 1

      // rotating lighthouse beams — the pulsar signature
      if (!reduced) {
        const ang = t * 0.45
        for (const off of [0, Math.PI]) {
          const grad = ctx.createLinearGradient(cx, cy,
            cx + Math.cos(ang + off) * W, cy + Math.sin(ang + off) * W)
          grad.addColorStop(0, `rgba(${cr},${cg},${cb},${speakingNow ? 0.16 : 0.08})`)
          grad.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.save()
          ctx.translate(cx, cy)
          ctx.rotate(ang + off)
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.moveTo(0, 0)
          ctx.arc(0, 0, Math.max(W, H), -0.05, 0.05)
          ctx.closePath()
          ctx.translate(-cx, -cy)
          ctx.fill()
          ctx.restore()
        }
      }

      // pulse rings
      ringsRef.current = ringsRef.current.filter((ring) => ring.alpha > 0.01)
      for (const ring of ringsRef.current) {
        ring.r += reduced ? 4 : 1.9 + ring.r * 0.012
        ring.alpha *= 0.972
        if (ring.r <= 0) continue
        ctx.beginPath()
        ctx.arc(cx, cy, ring.r, 0, Math.PI * 2)
        ctx.strokeStyle = ring.gold
          ? `rgba(255,190,60,${ring.alpha})`
          : `rgba(${cr},${cg},${cb},${ring.alpha})`
        ctx.lineWidth = ring.width
        ctx.stroke()
      }

      // core — breathing orb, agitated while speaking
      const breath = reduced ? 1 : 1 + 0.045 * Math.sin(t * (speakingNow ? 7 : 1.6))
      const jx = speakingNow && !reduced ? (Math.random() - 0.5) * 1.2 : 0
      const coreR = 26 * breath
      const glow = ctx.createRadialGradient(cx + jx, cy, 0, cx + jx, cy, coreR * 4.2)
      glow.addColorStop(0, `rgba(${cr},${cg},${cb},0.85)`)
      glow.addColorStop(0.25, `rgba(${cr},${cg},${cb},0.28)`)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx + jx, cy, coreR * 4.2, 0, Math.PI * 2)
      ctx.fill()

      const core = ctx.createRadialGradient(cx + jx - coreR * 0.3, cy - coreR * 0.3, 0, cx + jx, cy, coreR)
      core.addColorStop(0, '#ffffff')
      core.addColorStop(0.35, `rgb(${Math.min(255, cr + 70)},${Math.min(255, cg + 70)},${Math.min(255, cb + 70)})`)
      core.addColorStop(1, `rgb(${cr},${cg},${cb})`)
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx + jx, cy, coreR, 0, Math.PI * 2)
      ctx.fill()

      // speech "waveform" arcs around the core while speaking
      if (speakingNow && !reduced) {
        for (let i = 0; i < 3; i++) {
          const rr = coreR + 14 + i * 11
          const amp = 0.35 + 0.65 * Math.abs(Math.sin(t * (5 + i * 1.7) + i))
          ctx.beginPath()
          ctx.arc(cx, cy, rr, -0.6 - amp * 0.5, -0.6 + 0.5 + amp * 0.5)
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.5 - i * 0.13})`
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(cx, cy, rr, Math.PI - 0.6 - amp * 0.5, Math.PI - 0.1 + amp * 0.5)
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.5 - i * 0.13})`
          ctx.stroke()
        }
      }

      // vignette
      const vg = ctx.createRadialGradient(cx, H * 0.5, Math.min(W, H) * 0.35, cx, H * 0.5, Math.max(W, H) * 0.85)
      vg.addColorStop(0, 'rgba(0,0,0,0)')
      vg.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return <canvas ref={canvasRef} className={`h-full w-full ${className || ''}`} />
}
