import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Segment = { start:number; end:number; text:string }
type Word = { start:number; end:number; word:string }

function tcode(sec: number) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000).toString().padStart(2, '0')
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0')
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0')
  const mm = (ms % 1000).toString().padStart(3, '0')
  return `${h}:${m}:${s},${mm}`
}
function segmentsToSrt(segs: Segment[]) {
  return segs
    .map((s, i) => `${i + 1}\n${tcode(s.start)} --> ${tcode(s.end)}\n${s.text.replace(/\r?\n/g, ' ').trim()}\n`)
    .join('\n')
}

export async function POST(req: NextRequest) {
  try {
    const { audioUrl } = await req.json()
    if (!audioUrl) return j({ error:'missing_audioUrl' }, 400)

    // fetch the mp3 we uploaded to Vercel Blob
    const mp3Buf = Buffer.from(await fetch(audioUrl, { cache:'no-store' }).then(r => r.arrayBuffer()))

    // Whisper (segments + words)
    const fd = new FormData()
    fd.append('file', new Blob([mp3Buf], { type: 'audio/mpeg' }), 'voiceover.mp3')
    fd.append('model', 'whisper-1')
    fd.append('response_format', 'verbose_json')
    fd.append('timestamp_granularities[]', 'segment')
    fd.append('timestamp_granularities[]', 'word')

    const sttRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd
    })
    if (!sttRes.ok) return j({ error:'stt_failed', details: await sttRes.text() }, 500)
    const stt = await sttRes.json()

    const segs: Segment[] = (stt?.segments || []).map((s: any) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 1.5),
      text: String(s.text || '').trim()
    }))

    const words: Word[] = (stt?.words || []).map((w:any) => ({
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
      word: String(w.word || '').trim()
    }))

    // SRT (debug link)
    const srt = segmentsToSrt(segs)
    const { url: captionsUrl } = await put(`captions/${Date.now()}.srt`, Buffer.from(srt, 'utf-8'), {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    const transcript = (stt?.text || segs.map(s => s.text).join(' ')).trim()

    return j({
      audioUrl,
      transcript,
      segments: segs,
      words,
      captionsUrl
    })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
