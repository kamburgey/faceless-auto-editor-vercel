import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const dynamic = 'force-dynamic'
const j = (o: any, s = 200) => NextResponse.json(o, { status: s })

type Segment = { start: number; end: number; text: string }

// hh:mm:ss,mmm
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

// pick an sd file (fast) from Pexels video
function pickFile(v: any) {
  if (!v?.video_files?.length) return null
  return v.video_files.find((f: any) => f.quality === 'sd') ?? v.video_files[0]
}

export async function POST(req: NextRequest) {
  try {
    const { topic, niche, tone = 'Informative', targetDurationSec = 30, outputs = { portrait: true, landscape: true } } =
      await req.json()

    if (!topic || !niche) return j({ error: 'missing params' }, 400)

    // 1) Draft narration text (tone-aware)
    const narrationPrompt = `Write a ${targetDurationSec}s short-form voiceover about "${topic}" for the "${niche}" niche with a ${tone} tone.
Keep 110–150 words, punchy, high-retention. Output script only.`
    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: narrationPrompt }] })
    })
    if (!narrRes.ok) return j({ error: 'openai_narration', details: await narrRes.text() }, 500)
    const narration = (await narrRes.json()).choices[0].message.content as string

    // 2) ElevenLabs TTS → mp3 bytes
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: narration,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      })
    })
    if (!ttsRes.ok) return j({ error: 'elevenlabs_tts', details: await ttsRes.text() }, 500)
    const audioBuf = Buffer.from(await ttsRes.arrayBuffer())

    // 3) Host audio (public) via Vercel Blob (Shotstack needs a URL)
    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    // 4) Transcribe to get timed segments (we’ll use segment timestamps for clip timing + captions)
    const fd = new FormData()
    fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'voiceover.mp3')
    fd.append('model', 'whisper-1')                 // verbose JSON returns segments w/ start/end
    fd.append('response_format', 'verbose_json')
    const stt = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: '
