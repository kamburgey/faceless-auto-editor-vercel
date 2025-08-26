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
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd
    }).then(r => r.json())

    const segs: Segment[] =
      stt?.segments?.map((s: any) => ({
        start: Math.max(0, Number(s.start) || 0),
        end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 1.5),
        text: String(s.text || '').trim()
      })) ?? []

    // fallback if no segments
    if (!segs.length) {
      const avg = Math.max(1.5, targetDurationSec / 6)
      for (let i = 0; i < 6; i++) segs.push({ start: i * avg, end: (i + 1) * avg, text: narration })
    }

    // 5) Build captions (SRT) and upload
    const srt = segmentsToSrt(segs)
    const { url: captionsUrl } = await put(`captions/${Date.now()}.srt`, Buffer.from(srt, 'utf-8'), {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    // 6) For each segment, fetch a supporting clip from Pexels (video preferred)
    const headers = { Authorization: process.env.PEXELS_API_KEY! }
    const clips: { src: string; start: number; length: number }[] = []

    for (const s of segs) {
      // use segment text as the query (good baseline); you can refine later with LLM-generated keywords
      const r = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(s.text)}&per_page=5`,
        { headers }
      )
      if (!r.ok) continue
      const data = await r.json()
      const v = data.videos?.[0]
      const file = pickFile(v)
      if (!file?.link) continue
      const len = Math.max(1.5, Math.min((s.end - s.start) || 2.5, (v?.duration ?? 5)))
      clips.push({ src: file.link, start: s.start, length: len })
    }

    if (!clips.length) return j({ error: 'no_clips_found' }, 400)

    // 7) Build Shotstack timelines (9:16 + 16:9) with soundtrack + captions
    const makeTimeline = (aspectRatio: '9:16' | '16:9') => ({
      timeline: {
        background: '#000000',
        soundtrack: { src: audioUrl, effect: 'fadeOut' },
        tracks: [
          {
            clips: clips.map(c => ({
              asset: { type: 'video', src: c.src, trim: 0 },
              start: c.start,
              length: c.length,
              fit: 'cover',
              transition: { in: 'fade', out: 'fade' }
            }))
          },
          {
            clips: [
              {
                asset: { type: 'caption', src: captionsUrl },
                start: 0,
                length: segs[segs.length - 1].end + 0.5
              }
            ]
          }
        ]
      },
      output: { format: 'mp4', resolution: 'hd', aspectRatio }
    })

    async function render(tl: any) {
      const r = await fetch('https://api.shotstack.io/stage/render', {
        method: 'POST',
        headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY!, 'Content-Type': 'application/json' },
        body: JSON.stringify(tl)
      })
      const j = await r.json()
      return j?.response?.id as string | undefined
    }

    const jobs: { portrait?: string; landscape?: string } = {}
    if (outputs?.portrait) jobs.portrait = await render(makeTimeline('9:16'))
    if (outputs?.landscape) jobs.landscape = await render(makeTimeline('16:9'))

    return j({ jobs, audioUrl, captionsUrl, narration })
  } catch (e: any) {
    return j({ error: 'server_error', message: e?.message || String(e) }, 500)
  }
}
