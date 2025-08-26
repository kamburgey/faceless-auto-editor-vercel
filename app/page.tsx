'use client'
import { useEffect, useState } from 'react'

type Jobs = { portrait?: string; landscape?: string }

type Segment = {
  start: number
  end: number
  text: string
  visualQuery?: string
  assetPreference?: 'video' | 'image'
}
type Clip = { src: string; start: number; length: number; assetType: 'video' | 'image' }
type AssetMode = 'ai' | 'image_only' | 'image_first' | 'video_first'
type VOStyle = 'natural_conversational' | 'narrator_warm' | 'energetic'

const DEFAULT_UI_VOICE = 'wBXNqKUATyqu0RtYt25i' // literal default per your note

export default function Home() {
  // ---------- form ----------
  const [topic, setTopic] = useState('')
  const [niche, setNiche] = useState('food & drink')
  const [tone, setTone] = useState('informative, upbeat')
  const [dur, setDur] = useState<number>(25)

  // voiceover controls (sent to /api/jobs/start -> tts)
  const [voiceId, setVoiceId] = useState<string>(DEFAULT_UI_VOICE)
  const [voStyle, setVoStyle] = useState<VOStyle>('natural_conversational')
  const [voPace, setVoPace] = useState<number>(0.95) // slower = more natural cadence
  const [voBreaths, setVoBreaths] = useState<boolean>(true)

  // asset selection controls
  const [assetMode, setAssetMode] = useState<AssetMode>('ai') // AI preference (auto)
  const [usePortrait, setUsePortrait] = useState(true)
  const [useLandscape, setUseLandscape] = useState(true)

  // ---------- pipeline state ----------
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [narration, setNarration] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [captionsUrl, setCaptionsUrl] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [clips, setClips] = useState<Clip[] | null>(null)

  // ---------- render/poll ----------
  const [jobs, setJobs] = useState<Jobs>({})
  const [statusP, setStatusP] = useState('')
  const [statusL, setStatusL] = useState('')
  const [urlP, setUrlP] = useState<string | null>(null)
  const [urlL, setUrlL] = useState<string | null>(null)

  const pushProgress = (line: string) => setProgress(prev => [...prev, line])
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

  const safeJson = async (res: Response) => {
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) return res.json()
    const txt = await res.text()
    throw new Error(txt.slice(0, 200))
  }

  async function startJob(e: React.FormEvent) {
    e.preventDefault()
    if (running) return
    if (!usePortrait && !useLandscape) {
      alert('Select at least one output (TikTok and/or YouTube).')
      return
    }

    // reset
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
        body: JSON.stringify({
          topic,
          niche,
          tone,
          targetDurationSec: Number(dur),
          // Voiceover knobs (server honors these)
          tts: {
            voiceId: voiceId?.trim() || undefined,
            style: voStyle,       // 'natural_conversational' | 'narrator_warm' | 'energetic'
            pace: voPace,         // 0.85–1.15 typical
            breaths: voBreaths    // hint to insert natural micro-pauses
          }
        })
      })
      if (!s1.ok) throw new Error(await s1.text())
      const d1 = await safeJson(s1)
      setNarration(d1.narration || null)
      setAudioUrl(d1.audioUrl || null)

      // 2) STT (segments+words)
      pushProgress('2/4 Transcribing (segments + words)…')
      const s2 = await fetch('/api/jobs/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: d1.audioUrl })
      })
      if (!s2.ok) throw new Error(await s2.text())
      const d2 = await safeJson(s2)
      setCaptionsUrl(d2.captionsUrl || null)

      // 2.5) Storyboard with min/max beat length (LLM)
      pushProgress('2.5/4 Planning visuals per sentence…')
      const s25 = await fetch('/api/jobs/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: d2.transcript,
          words: d2.words,
          niche,
          tone,
          targetDurationSec: Number(dur)
        })
      })
      if (!s25.ok) throw new Error(await s25.text())
      const d25 = await safeJson(s25)
      const beats: Segment[] = d25.beats
      setSegments(beats)

      // 3) choose clips for each beat
      pushProgress(`3/4 Selecting b-roll… (0/${beats.length})`)
      const chosen: Clip[] = []
      for (let i = 0; i < beats.length; i++) {
        try {
          const payload: any = {
            segment: beats[i],
            visualQuery: beats[i].visualQuery,
            assetPreference: beats[i].assetPreference,
            outputs: { portrait: usePortrait, landscape: useLandscape }
          }
          if (assetMode !== 'ai') payload.assetMode = assetMode // only override if user chose a mode

          const r = await fetch('/api/jobs/choose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
          if (!r.ok) throw new Error(await r.text())
          const jr = await safeJson(r)
          if (jr?.clip) chosen.push(jr.clip)
        } catch (err: any) {
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
          captionsUrl: d2.captionsUrl, // uploaded by STT (not burned-in)
          outputs: { portrait: usePortrait, landscape: useLandscape }
        })
      })
      if (!r.ok) throw new Error(await r.text())
      const d3 = await safeJson(r)
      setJobs(d3.jobs || {})
      pushProgress('Queued. Polling render status…')
    } catch (err: any) {
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
      <h1>Faceless Auto-Editor (storyboarded)</h1>

      <form onSubmit={startJob} style={{ display: 'grid', gap: 12 }}>
        <label>Topic <input value={topic} onChange={e => setTopic(e.target.value)} required /></label>
        <label>Niche <input value={niche} onChange={e => setNiche(e.target.value)} required /></label>
        <label>Tone <input value={tone} onChange={e => setTone(e.target.value)} placeholder="Informative, playful, dramatic…" /></label>
        <label>Target Duration (sec) <input type="number" min={10} value={dur} onChange={e => setDur(Number(e.target.value))} /></label>

        <fieldset style={{ border:'1px solid #333', borderRadius:8, padding:10 }}>
          <legend>Voiceover</legend>
          <label>
            ElevenLabs Voice ID
            <input
              value={voiceId}
              onChange={e => setVoiceId(e.target.value)}
              placeholder="wBXNqKUATyqu0RtYt25i"
              style={{ marginLeft: 8, width: 290 }}
            />
          </label>
          <label style={{ marginLeft: 12 }}>
            Style{' '}
            <select value={voStyle} onChange={e => setVoStyle(e.target.value as VOStyle)} style={{ marginLeft: 6 }}>
              <option value="natural_conversational">Natural · conversational</option>
              <option value="narrator_warm">Narrator · warm</option>
              <option value="energetic">Energetic · punchy</option>
            </select>
          </label>
          <label style={{ marginLeft: 12 }}>
            Pace: <code>{voPace.toFixed(2)}×</code>
            <input
              type="range"
              min={0.85}
              max={1.15}
              step={0.01}
              value={voPace}
              onChange={e => setVoPace(Number(e.target.value))}
              style={{ marginLeft: 6, verticalAlign: 'middle' }}
            />
          </label>
          <label style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={voBreaths} onChange={e => setVoBreaths(e.target.checked)} /> Natural pauses/breaths
          </label>
        </fieldset>

        <label>
          Asset mode
          <select value={assetMode} onChange={e => setAssetMode(e.target.value as AssetMode)} style={{ marginLeft: 8 }}>
            <option value="ai">AI preference (auto)</option>
            <option value="image_only">Images only (safest)</option>
            <option value="image_first">Images first (fallback to video)</option>
            <option value="video_first">Video first (fallback to image)</option>
          </select>
        </label>

        <label><input type="checkbox" checked={usePortrait} onChange={e => setUsePortrait(e.target.checked)} /> Generate TikTok (9:16)</label>
        <label><input type="checkbox" checked={useLandscape} onChange={e => setUseLandscape(e.target.checked)} /> Generate YouTube (16:9)</label>

        <button type="submit" disabled={running}>{running ? 'Building…' : 'Build'}</button>
      </form>

      {progress.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #333', borderRadius: 8 }}>
          <b>Progress</b>
          <ol style={{ marginTop: 8 }}>
            {progress.map((p, i) => <li key={i}>{p}</li>)}
          </ol>
        </div>
      )}

      {(narration || audioUrl || captionsUrl) && (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          {narration && <div style={{ marginBottom: 8 }}><b>Narration:</b> <span style={{ whiteSpace: 'pre-wrap' }}>{narration}</span></div>}
          {audioUrl && <div><a href={audioUrl} target="_blank" rel="noreferrer">Voiceover (MP3)</a></div>}
          {captionsUrl && <div><a href={captionsUrl} target="_blank" rel="noreferrer">Captions (SRT)</a></div>}
          {segments && <div>Segments: {segments.length}{clips && <> · Clips chosen: {clips.length}</>}</div>}
        </div>
      )}

      {/* Storyboard debug panel */}
      {segments && segments.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>
            Storyboard debug (LLM visual queries) — {segments.length} beats
          </summary>
          <ol style={{ marginTop: 8, lineHeight: 1.4 }}>
            {segments.map((b, i) => {
              const chosen = clips?.[i]; // best-effort alignment
              return (
                <li key={i}>
                  <code>[{fmt(b.start)}–{fmt(b.end)}s]</code>{' '}
                  <b>{(b.assetPreference || 'auto').toUpperCase()}</b>{' '}
                  — <i>{b.visualQuery || '(no query)'}</i>
                  {chosen && (
                    <> · chosen: <b>{chosen.assetType}</b> · {fmt(chosen.length)}s</>
                  )}
                </li>
              )
            })}
          </ol>
        </details>
      )}

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
