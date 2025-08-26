
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const j = (o: any, s=200) => NextResponse.json(o, { status: s })

export async function POST(req: NextRequest) {
  try {
    const { topic, niche, targetDurationSec } = await req.json()
    if (!topic || !niche || !targetDurationSec) return j({ error: 'missing params' }, 400)

    // 1) LLM: beat sheet JSON
    const prompt = `Make a concise beat sheet for a ${targetDurationSec}s video on "${topic}" in the "${niche}" niche.
Return strictly JSON: {"beats":[{"caption":string,"query":string,"durationSec":number}]}. Use 5-9 beats, sum durations to ~${targetDurationSec}.`

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    })
    if (!openaiRes.ok) {
      const msg = await openaiRes.text().catch(()=> '')
      return j({ error: 'openai_failed', details: msg }, 500)
    }
    const beatsMsg = await openaiRes.json()
    const beats = JSON.parse(beatsMsg.choices[0].message.content).beats as {caption:string,query:string,durationSec:number}[]

    // 2) Pexels: get one clip per beat
    const headers = { Authorization: process.env.PEXELS_API_KEY as string }
    const clips: { src: string; start: number; length: number }[] = []
    let cursor = 0
    for (const b of beats) {
      const sr = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(b.query)}&per_page=3`, { headers })
      if (!sr.ok) continue
      const data = await sr.json()
      const first = data.videos?.[0]
      if (!first) continue
      const file = first.video_files?.find((f:any)=>f.quality==='sd') || first.video_files?.[0]
      if (!file?.link) continue
      const length = Math.max(2, Math.min(b.durationSec || 3, first.duration || b.durationSec || 3))
      clips.push({ src: file.link, start: cursor, length })
      cursor += length
    }

    if (clips.length === 0) return j({ error: 'no_clips_found' }, 400)

    // 3) Shotstack timeline
    const timeline = {
      timeline: {
        background: '#000000',
        tracks: [{
          clips: clips.map(c => ({
            asset: { type: 'video', src: c.src, trim: 0 },
            start: c.start,
            length: c.length,
            fit: 'cover',
            transition: { in: 'fade', out: 'fade' }
          }))
        }]
      },
      output: { format: 'mp4', resolution: 'sd' }
    }

    const renderRes = await fetch('https://api.shotstack.io/stage/render', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.SHOTSTACK_API_KEY as string,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(timeline)
    })
    const renderJson = await renderRes.json()
    const jobId = renderJson?.response?.id
    if (!jobId) return j({ error: 'shotstack_failed', details: renderJson }, 500)

    return j({ jobId })
  } catch (e:any) {
    return j({ error: 'server_error', message: e?.message || String(e) }, 500)
  }
}
