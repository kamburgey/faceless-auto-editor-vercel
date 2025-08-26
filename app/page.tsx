'use client'
import { useEffect, useState } from 'react'

type Jobs = { portrait?: string; landscape?: string }
type Segment = { start: number; end: number; text: string }
type Clip = { src: string; start: number; length: number; assetType: 'video' | 'image' }

export default function Home() {
  // form
  const [topic, setTopic] = useState('')
  const [niche, setNiche] = useState('General')
  const [tone, setTone] = useState('Informative')
  const [dur, setDur] = useState<number>(30)
  const [usePortrait, setUsePortrait] = useState(true)   // 9:16
  const [useLandscape, setUseLandscape] = useState(true) // 16:9

  // pipeline state
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [narration, setNarration] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [captionsUrl, setCaptionsUrl] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [clips, setClips] = useState<Clip[] | null>(null)

  // renders/polling
  const [jobs, setJobs] = useState<Jobs>({})
  const [statusP, setStatusP] = useState('')  // portrait status
  const [statusL, setStatusL] = useState('')  // landscape status
  const [urlP, setUrlP] = useState<string | null>(null)
  const [urlL, setUrlL] = useState<string | null>(null)

  function pushProgress(line: string) {
    setProgress(prev => [...prev, line])
  }

  async function startJob(e: React.FormEvent) {
    e.preventDefault()
    if (running) return
    if (!usePortrait && !useLandscape) {
      alert('Select at least one output (TikTok and/or YouTube).')
      return
    }

    // reset UI
    setRunning(true)
    setProgress([])
    setNarration(null); setAudioUrl(null); setCaptionsUrl(null)
    setSegments(null); setClips(null)
    setJobs({}); setStatusP(''); setStatusL(''); setUrlP(null); setUrlL(null)

    try {
      // 1) narration + TTS + blob
      pushProgress('1/4 Narration + TTS…')
      const s1 = await fetch('/api/jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, niche, tone, targetDurationSec: Number(dur) })
      })
      if (!s1.ok) throw new Error('Narration/TTS failed')
      const d1 = await s1.json()
      setNarration(d1.narration || null)
      setAudioUrl(d1.audioUrl || null)

      // 2) STT + captions
      pushProgress('2/4 Transcribing + captions…')
      const s2 = await fetch('/api/jobs/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioUrl: d1.audioUrl,
          targetDurationSec: Number(dur),
          narration: d1.narration
        })
      })
      if (!s2.ok) throw new Error('Transcription failed')
      const d2 = await s2.json()
      setSegments(d2.segments || [])
      setCaptionsUrl(d2.captionsUrl || null)

      // 3) Choose clips (sequential per segment to avoid timeouts)
      const segs: Segment[] = d2.segments || []
      pushProgress(`3/4 Selecting b-roll… (0/${segs.length})`)
      const chosen: Clip[] = []
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]
        const r = await fetch('/api/jobs/choose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segment: seg,
            outputs: { portrait: usePortrait, landscape: useLandscape }
          })
        })
        const jr = await r.json()
        if (jr?.clip) chosen.push(jr.clip)
        pushProgress(`3/4 Selecting b-roll… (${i + 1}/${segs.length})`)
      }
      if (!chosen.length) throw new Error('No clips chosen')
      setClips(chosen)

      // 4) Render timelines
      pushProgress('4/4 Rendering with Shotstack…')
      const r = await fetch('/api/jobs/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: chosen,
          audioUrl: d1.audioUrl,
          captionsUrl: d2.captionsUrl,
          outputs: { portrait: usePortrait, landscape: useLandscape }
        })
      })
      if (!r.ok) throw new Error('Render kickoff failed')
      const d3 = await r.json()
      setJobs(d3.jobs || {})
      pushProgress('Queued. Polling render status…')
    } catch (err: any) {
      console.error(err)
      alert(`Failed to start job. ${err?.message || String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  // watch portrait job
  useEffect(() => {
    if (!jobs.portrait) return
    setStatusP('queued')
    const id = jobs.portrait
    const t = setInterval(async () => {
      const r = await fetch(`/api/jobs/${id}`)
      if (!r.ok) return
      const d = await r.json()
      setStatusP(d.status)
      if (d.status === 'done') { setUrlP(d.url); clearInterval(t) }
      if (d.status === 'failed') { clearInterval(t) }
    }, 1500)
    return () => clearInterval(t)
  }, [jobs.portrait])

  // watch landscape job
  useEffect(() => {
    if (!jobs.landscape) return
    setStatusL('queued')
    const id = jobs.landscape
    const t = setInterval(async () => {
      const r = await fetch(`/api/jobs/${id}`)
      if (!r.ok) return
      const d = await r.json()
      setStatusL(d.status)
      if (d.status === 'done') { setUrlL(d.url); clearInterval(t) }
      if (d.status === 'failed') { clearInterval(t) }
    }, 1500)
    return () => clearInterval(t)
  }, [jobs.landscape])

  return (
    <main style={{ maxWidth: 760, margin: '2rem auto', fontFamily: 'ui-sans-serif' }}>
      <h1>Faceless Auto-Editor (pipeline)</h1>

      <form onSubmit={startJob} style={{ display: 'grid', gap: 12 }}>
        <label>Topic <input value={topic} onChange={e => setTopic(e.target.value)} required /></label>
        <label>Niche <input value={niche} onChange={e => setNiche(e.target.value)} required /></label>
        <label>Tone <input value={tone} onChange={e => setTone(e.target.value)} placeholder="Informative, playful, dramatic…" /></label>
        <label>Target Duration (sec) <input type="number" min={10} value={dur} onChange={e => setDur(Number(e.target.value))} /></label>

        <label><input type="checkbox" checked={usePortrait} onChange={e => setUsePortrait(e.target.checked)} /> Generate TikTok (9:16)</label>
        <label><input type="checkbox" checked={useLandscape} onChange={e => setUseLandscape(e.target.checked)} /> Generate YouTube (16:9)</label>

        <button type="submit" disabled={running}>{running ? 'Building…' : 'Build'}</button>
      </form>

      {/* Progress */}
      {progress.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
          <b>Progress</b>
          <ol style={{ marginTop: 8 }}>
            {progress.map((p, i) => <li key={i}>{p}</li>)}
          </ol>
        </div>
      )}

      {/* Debug info (optional links) */}
      {(narration || audioUrl || captionsUrl) && (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          {narration && <div><b>Narration:</b> <span style={{ whiteSpace: 'pre-wrap' }}>{narration}</span></div>}
          {audioUrl && <div><a href={audioUrl} target="_blank" rel="noreferrer">Voiceover (MP3)</a></div>}
          {captionsUrl && <div><a href={captionsUrl} target="_blank" rel="noreferrer">Captions (SRT)</a></div>}
          {segments && <div>Segments: {segments.length}{clips && <> · Clips chosen: {clips.length}</>}</div>}
        </div>
      )}

      {/* Results */}
      {(jobs.portrait || jobs.landscape) && (
        <div style={{ marginTop: 20, display: 'grid', gap: 16 }}>
          {jobs.portrait && (
            <div>
              <div><b>9:16 status:</b> {statusP}</div>
              {urlP && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <video src={urlP} controls style={{ width: '100%', borderRadius: 12 }} />
                  </div>
                  <a href={urlP} target="_blank" rel="noreferrer">Open 9:16</a>
                </>
              )}
            </div>
          )}

          {jobs.landscape && (
            <div>
              <div><b>16:9 status:</b> {statusL}</div>
              {urlL && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <video src={urlL} controls style={{ width: '100%', borderRadius: 12 }} />
                  </div>
                  <a href={urlL} target="_blank" rel="noreferrer">Open 16:9</a>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  )
}
