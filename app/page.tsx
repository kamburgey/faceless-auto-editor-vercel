'use client'
import { useEffect, useState } from 'react'

type Jobs = { portrait?: string; landscape?: string }
type Segment = { start: number; end: number; text: string }
type Clip = { src: string; start: number; length: number; assetType: 'video' | 'image' }

export default function Home() {
  // form
  const [topic, setTopic] = useState('')
  const [niche, setNiche] = useState('food & drink')
  const [tone, setTone] = useState('informative, upbeat')
  const [dur, setDur] = useState<number>(25)
  const [usePortrait, setUsePortrait] = useState(true)
  const [useLandscape, setUseLandscape] = useState(true)

  // pipeline state
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [narration, setNarration] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [clips, setClips] = useState<Clip[] | null>(null)

  // render/poll
  const [jobs, setJobs] = useState<Jobs>({})
  const [statusP, setStatusP] = useState('')
  const [statusL, setStatusL] = useState('')
  const [urlP, setUrlP] = useState<string | null>(null)
  const [urlL, setUrlL] = useState<string | null>(null)

  function pushProgress(line: string) { setProgress(prev => [...prev, line]) }
  async function safeJson(res: Response) {
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) return res.json()
    const txt = await res.text(); throw new Error(txt.slice(0, 200))
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
    // 1) narration + TTS
    pushProgress('1/4 Narration + TTS…')
    const s1 = await fetch('/api/jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, niche, tone, targetDurationSec: Number(dur) })
    })
    if (!s1.ok) throw new Error(await s1.text())
    const d1 = await s1.json()
    setNarration(d1.narration || null)
    setAudioUrl(d1.audioUrl || null)

    // 2) STT (segments + words)
    pushProgress('2/4 Transcribing (segments + words)…')
    const s2 = await fetch('/api/jobs/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl: d1.audioUrl })
    })
    if (!s2.ok) throw new Error(await s2.text())
    const d2 = await s2.json()
    setCaptionsUrl(d2.captionsUrl || null)

    // 2.5) LLM scene beats (re-segmentation)
    pushProgress('2.5/4 Finding smart scene beats…')
    const s25 = await fetch('/api/jobs/resegment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: d2.transcript,
        segments: d2.segments,
        words: d2.words,
        targetDurationSec: Number(dur)
      })
    })
    if (!s25.ok) throw new Error(await s25.text())
    const d25 = await s25.json()
    const beats = d25.beats || d2.segments
    setSegments(beats)

    // 3) choose clips per beat
    pushProgress(`3/4 Selecting b-roll… (0/${beats.length})`)
    const chosen: Clip[] = []
    for (let i = 0; i < beats.length; i++) {
      try {
        const r = await fetch('/api/jobs/choose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segment: beats[i], outputs: { portrait: usePortrait, landscape: useLandscape } })
        })
        if (!r.ok) throw new Error(await r.text())
        const jr = await r.json()
        if (jr?.clip) chosen.push(jr.clip)
      } catch (err:any) {
        pushProgress(`• Segment ${i + 1} error: ${err?.message?.slice(0,120) || String(err)}`)
      }
      pushProgress(`3/4 Selecting b-roll… (${i + 1}/${beats.length})`)
    }
    if (!chosen.length) { alert('No clips chosen (see Progress).'); return }
    setClips(chosen)

    // 4) render
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
    if (!r.ok) throw new Error(await r.text())
    const d3 = await r.json()
    setJobs(d3.jobs || {})
    pushProgress('Queued. Polling render status…')
  } catch (err:any) {
    console.error(err)
    alert(`Failed to start job. ${err?.message || String(err)}`)
  } finally {
    setRunning(false)
  }
}

  // poll 9:16
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

  // poll 16:9
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

      {progress.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
          <b>Progress</b>
          <ol style={{ marginTop: 8 }}>{progress.map((p,i)=><li key={i}>{p}</li>)}</ol>
        </div>
      )}

      {(narration || audioUrl) && (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          {narration && <div style={{ marginBottom: 8 }}><b>Narration:</b> <span style={{ whiteSpace: 'pre-wrap' }}>{narration}</span></div>}
          {audioUrl && <div><a href={audioUrl} target="_blank" rel="noreferrer">Voiceover (MP3)</a></div>}
          {segments && <div>Segments: {segments.length}{clips && <> · Clips chosen: {clips.length}</>}</div>}
        </div>
      )}

      {(jobs.portrait || jobs.landscape) && (
        <div style={{ marginTop: 20, display: 'grid', gap: 16 }}>
          {jobs.portrait && (
            <div>
              <div><b>9:16 status:</b> {statusP}</div>
              {urlP && (
                <>
                  <div style={{ marginTop: 8 }}><video src={urlP} controls style={{ width: '100%', borderRadius: 12 }} /></div>
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
                  <div style={{ marginTop: 8 }}><video src={urlL} controls style={{ width: '100%', borderRadius: 12 }} /></div>
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
