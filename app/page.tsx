
'use client'
import { useEffect, useState } from 'react'

export default function Home() {
  const [topic, setTopic] = useState('')
  const [niche, setNiche] = useState('General')
  const [dur, setDur] = useState<number>(15)
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  async function startJob(e: React.FormEvent) {
    e.preventDefault()
    setVideoUrl(null)
    setStatus('starting…')

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, niche, targetDurationSec: Number(dur) })
    })
    if (!res.ok) { setStatus('failed'); alert('Failed to start'); return }
    const { jobId } = await res.json()
    setJobId(jobId)
    setStatus('queued')
  }

  useEffect(() => {
    if (!jobId) return
    const iv = setInterval(async () => {
      const r = await fetch(`/api/jobs/${jobId}`)
      if (!r.ok) return
      const d = await r.json()
      setStatus(d.status)
      if (d.status === 'done') { setVideoUrl(d.url); clearInterval(iv) }
      if (d.status === 'failed') { clearInterval(iv); alert(d.message || 'Render failed') }
    }, 1500)
    return () => clearInterval(iv)
  }, [jobId])

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'ui-sans-serif' }}>
      <h1>Faceless Auto-Editor (v0 – Vercel-only)</h1>

      <form onSubmit={startJob} style={{ display: 'grid', gap: 12 }}>
        <label>Topic <input value={topic} onChange={e => setTopic(e.target.value)} required /></label>
        <label>Niche <input value={niche} onChange={e => setNiche(e.target.value)} required /></label>
        <label>Target Duration (sec) <input type="number" value={dur} min={10} onChange={e => setDur(Number(e.target.value))} /></label>
        <button type="submit">Build</button>
      </form>

      {jobId && <div style={{ marginTop: 20 }}>
        <div><b>Job:</b> {jobId}</div>
        <div><b>Status:</b> {status}</div>
      </div>}

      {videoUrl && <div style={{ marginTop: 20 }}>
        <video src={videoUrl} controls style={{ width: '100%', borderRadius: 12 }} />
        <div style={{ marginTop: 8 }}><a href={videoUrl} target="_blank">Open in new tab</a></div>
      </div>}
    </main>
  )
}
