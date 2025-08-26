'use client'
import { useEffect, useState } from 'react'

type Jobs = { portrait?: string; landscape?: string }

export default function Home() {
  const [topic, setTopic] = useState('')
  const [niche, setNiche] = useState('General')
  const [tone, setTone] = useState('Informative')
  const [dur, setDur] = useState<number>(30)

  const [usePortrait, setUsePortrait] = useState(true)   // 9:16 (TikTok)
  const [useLandscape, setUseLandscape] = useState(true) // 16:9 (YouTube)

  const [jobs, setJobs] = useState<Jobs>({})
  const [statusP, setStatusP] = useState('')  // portrait status
  const [statusL, setStatusL] = useState('')  // landscape status
  const [urlP, setUrlP] = useState<string | null>(null)
  const [urlL, setUrlL] = useState<string | null>(null)

  async function startJob(e: React.FormEvent) {
    e.preventDefault()
    if (!usePortrait && !useLandscape) {
      alert('Select at least one output (TikTok and/or YouTube).')
      return
    }
    setUrlP(null); setUrlL(null); setStatusP(''); setStatusL('')

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        niche,
        tone,
        targetDurationSec: Number(dur),
        outputs: { portrait: usePortrait, landscape: useLandscape }
      })
    })

    if (!res.ok) {
      const msg = await res.text().catch(() => '')
      alert(`Failed to start job. ${msg}`)
      return
    }

    const data = await res.json()
    setJobs(data.jobs || {})
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
    <main style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'ui-sans-serif' }}>
      <h1>Faceless Auto-Editor (v0.2)</h1>

      <form onSubmit={startJob} style={{ display: 'grid', gap: 12 }}>
        <label>Topic <input value={topic} onChange={e => setTopic(e.target.value)} required /></label>
        <label>Niche <input value={niche} onChange={e => setNiche(e.target.value)} required /></label>
        <label>Tone <input value={tone} onChange={e => setTone(e.target.value)} placeholder="Informative, playful, dramatic…" /></label>
        <label>Target Duration (sec) <input type="number" min={10} value={dur} onChange={e => setDur(Number(e.target.value))} /></label>

        <label><input type="checkbox" checked={usePortrait} onChange={e => setUsePortrait(e.target.checked)} /> Generate TikTok (9:16)</label>
        <label><input type="checkbox" checked={useLandscape} onChange={e => setUseLandscape(e.target.checked)} /> Generate YouTube (16:9)</label>

        <button type="submit">Build</button>
      </form>

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
