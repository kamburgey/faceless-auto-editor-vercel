import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
const j=(o:any,s=200)=>NextResponse.json(o,{status:s})

type Segment={start:number;end:number;text:string}
const t=(n:number)=>String(n).padStart(2,'0')
const tc=(sec:number)=>{const ms=Math.max(0,Math.round(sec*1000));return `${t(Math.floor(ms/3600000))}:${t(Math.floor(ms%3600000/60000))}:${t(Math.floor(ms%60000/1000))},${String(ms%1000).padStart(3,'0')}`}
const toSrt=(segs:Segment[])=>segs.map((s,i)=>`${i+1}\n${tc(s.start)} --> ${tc(s.end)}\n${s.text.replace(/\r?\n/g,' ').trim()}\n`).join('\n')

export async function POST(req: NextRequest) {
  try {
    const { audioUrl, targetDurationSec=30, narration } = await req.json()
    if (!audioUrl) return j({error:'missing audioUrl'},400)

    const audio = await fetch(audioUrl)
    if (!audio.ok) return j({error:'fetch_audio_failed', details: await audio.text()}, 500)
    const audioBuf = Buffer.from(await audio.arrayBuffer())

    const fd = new FormData()
    fd.append('file', new Blob([audioBuf], {type:'audio/mpeg'}), 'voiceover.mp3')
    fd.append('model','whisper-1')
    fd.append('response_format','verbose_json')
    fd.append('timestamp_granularities[]','segment')
    fd.append('timestamp_granularities[]','word')
    const stt = await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST', headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`}, body:fd}).then(r=>r.json())

    let segs: Segment[] = (stt?.segments || []).map((s:any)=>({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 1.5),
      text: String(s.text||'').trim()
    }))

    if (!segs.length) {
      const avg = Math.max(1.5, targetDurationSec/6)
      segs = Array.from({length:6},(_,i)=>({start:i*avg,end:(i+1)*avg,text:narration||''}))
    }

    const srt = toSrt(segs)
    const { url: captionsUrl } = await put(`captions/${Date.now()}.srt`, Buffer.from(srt,'utf-8'), { access:'public', token:process.env.BLOB_READ_WRITE_TOKEN })

    return j({ segments: segs, captionsUrl })
  } catch(e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
