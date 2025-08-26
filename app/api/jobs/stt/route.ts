import { NextRequest, NextResponse } from 'next/server'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
const j=(o:any,s=200)=>NextResponse.json(o,{status:s})

type Segment={start:number;end:number;text:string}

// merge tiny Whisper segments into ~6–8 beats
function mergeSegments(raw: Segment[], minLen=3.0, maxSegs=8): Segment[] {
  if (!raw.length) return raw
  const out: Segment[] = []
  let cur: Segment = { ...raw[0] }
  for (let i = 1; i < raw.length; i++) {
    const next = raw[i]
    const curLen = cur.end - cur.start
    const remaining = raw.length - i
    if (curLen < minLen || (out.length + 1 + remaining) > maxSegs) {
      cur.end = Math.max(cur.end, next.end)
      cur.text = (cur.text + ' ' + next.text).trim()
    } else {
      out.push(cur)
      cur = { ...next }
    }
  }
  out.push(cur)
  while (out.length > maxSegs && out.length > 1) {
    let bestIdx = 0, bestSpan = Infinity
    for (let i = 0; i < out.length - 1; i++) {
      const span = out[i+1].end - out[i].start
      if (span < bestSpan) { bestSpan = span; bestIdx = i }
    }
    out[bestIdx] = {
      start: out[bestIdx].start,
      end: out[bestIdx+1].end,
      text: (out[bestIdx].text + ' ' + out[bestIdx+1].text).trim()
    }
    out.splice(bestIdx+1, 1)
  }
  return out
}

export async function POST(req: NextRequest) {
  try {
    const { audioUrl, targetDurationSec=30, narration } = await req.json()
    if (!audioUrl) return j({error:'missing_audioUrl'},400)

    const audio = await fetch(audioUrl)
    if (!audio.ok) return j({error:'fetch_audio_failed', details: await audio.text()}, 500)
    const audioBuf = Buffer.from(await audio.arrayBuffer())

    const fd = new FormData()
    fd.append('file', new Blob([audioBuf], {type:'audio/mpeg'}), 'voiceover.mp3')
    fd.append('model','whisper-1')
    fd.append('response_format','verbose_json')
    fd.append('timestamp_granularities[]','segment')
    fd.append('timestamp_granularities[]','word')
    const stt = await fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'POST',
      headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:fd
    }).then(r=>r.json())

    let segs: Segment[] = (stt?.segments || []).map((s:any)=>({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 1.5),
      text: String(s.text||'').trim()
    }))

    if (!segs.length) {
      const avg = Math.max(1.5, targetDurationSec/6)
      segs = Array.from({length:6},(_,i)=>({start:i*avg,end:(i+1)*avg,text:narration||''}))
    }

    segs = mergeSegments(segs, 3.0, 8)

    return j({ segments: segs })
  } catch(e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
