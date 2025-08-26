import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const dynamic = 'force-dynamic'
const j = (o: any, s = 200) => NextResponse.json(o, { status: s })

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const MAX_CANDIDATES_PER_SEGMENT = 5
const FRAMES_PER_CANDIDATE = 2

type Segment = { start: number; end: number; text: string }
type ClipPick = { src: string; start: number; length: number; assetType: 'video' | 'image' }

// --- helpers ---
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
function pickSdFile(v: any) {
  const files = v?.video_files || []
  return files.find((f: any) => f.quality === 'sd') ?? files[0]
}
function pickFrames(video_pictures: any[], count: number) {
  if (!Array.isArray(video_pictures) || video_pictures.length === 0) return []
  if (video_pictures.length <= count) return video_pictures.map((p: any) => p.picture)
  const step = Math.max(1, Math.floor(video_pictures.length / count))
  const frames: string[] = []
  for (let i = 0; i < video_pictures.length && frames.length < count; i += step) {
    frames.push(video_pictures[i].picture)
  }
  return frames
}
function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)) }

// --- main ---
export async function POST(req: NextRequest) {
  try {
    const { topic, niche, tone = 'Informative', targetDurationSec = 30, outputs = { portrait: true, landscape: true } } =
      await req.json()

    if (!topic || !niche) return j({ error: 'missing params' }, 400)

    // 1) Narration (tone-aware)
    const narrationPrompt = `Write a ${targetDurationSec}s short-form voiceover about "${topic}" for the "${niche}" niche with a ${tone} tone.
Keep 110–150 words, punchy, high-retention. Output script only.`
    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: narrationPrompt }],
        reasoning_effort: 'high',
        verbosity: 'low'
      })
    })
    if (!narrRes.ok) return j({ error: 'openai_narration', details: await narrRes.text() }, 500)
    const narration = (await narrRes.json()).choices[0].message.content as string

    // 2) ElevenLabs TTS → MP3
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

    // 3) Upload audio → Blob (public URL for Shotstack)
    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    // 4) Transcribe → segments (+ words)
    const fd = new FormData()
    fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'voiceover.mp3')
    fd.append('model', 'whisper-1')
    fd.append('response_format', 'verbose_json')
    fd.append('timestamp_granularities[]', 'segment')
    fd.append('timestamp_granularities[]', 'word')
    const stt = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd
    }).then(r => r.json())

    const segs: Segment[] = (stt?.segments || []).map((s: any) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 1.5),
      text: String(s.text || '').trim()
    }))

    // Fallback if needed
    if (!segs.length) {
      const avg = Math.max(1.5, targetDurationSec / 6)
      for (let i = 0; i < 6; i++) segs.push({ start: i * avg, end: (i + 1) * avg, text: narration })
    }

    // 5) Captions (SRT) → Blob
    const srt = segmentsToSrt(segs)
    const { url: captionsUrl } = await put(`captions/${Date.now()}.srt`, Buffer.from(srt, 'utf-8'), {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    // 6) For each segment: search Pexels → (video first, photo fallback) → pick best via GPT-5 vision on frames
    const headers = { Authorization: process.env.PEXELS_API_KEY! }
    const chosenClips: ClipPick[] = []
    const aspectHints: string[] = []
    if (outputs?.portrait) aspectHints.push('9:16')
    if (outputs?.landscape) aspectHints.push('16:9')
    const aspectText = aspectHints.length ? `Target aspect ratio(s): ${aspectHints.join(' & ')}.\n` : ''

    for (const s of segs) {
      const segLen = clamp(s.end - s.start, 1.5, 7)

      // --- video candidates ---
      const vr = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(s.text)}&per_page=${MAX_CANDIDATES_PER_SEGMENT * 2}`,
        { headers }
      )

      let candidates: Array<{
        id: number|string
        src: string
        duration: number
        frames: string[]
        assetType: 'video'|'image'
        width?: number
        height?: number
      }> = []

      if (vr.ok) {
        const vd = await vr.json()
        const uniq: any[] = []
        const seen = new Set()
        for (const v of (vd.videos || [])) {
          if (seen.has(v.id)) continue
          seen.add(v.id)
          uniq.push(v)
        }
        candidates = uniq.slice(0, MAX_CANDIDATES_PER_SEGMENT).map((v: any) => {
          const file = pickSdFile(v)
          const frames = pickFrames(v.video_pictures || [], FRAMES_PER_CANDIDATE)
          const cover = v.image ? [v.image] : []
          return {
            id: v.id,
            src: file?.link,
            duration: v.duration || segLen,
            frames: frames.length ? frames : cover,
            assetType: 'video' as const,
            width: v.width, height: v.height
          }
        }).filter((c: any) => !!c.src)
      }

      // --- photo fallback if no video candidates ---
      if (!candidates.length) {
        const pr = await fetch(
          `https://api.pexels.com/v1/search?query=${encodeURIComponent(s.text)}&per_page=${MAX_CANDIDATES_PER_SEGMENT}`,
          { headers }
        )
        if (pr.ok) {
          const pd = await pr.json()
          candidates = (pd.photos || []).map((p: any) => ({
            id: p.id,
            src: p.src?.original || p.src?.large2x || p.src?.large,
            duration: segLen, // still holds over the whole segment
            frames: [p.src?.medium || p.src?.large || p.src?.original].filter(Boolean),
            assetType: 'image' as const,
            width: p.width, height: p.height
          })).filter((c: any) => !!c.src)
        }
      }

      if (!candidates.length) continue

      // --- ask GPT-5 (vision) to pick best candidate using frames ---
      const content: any[] = [
        {
          type: 'text',
          text:
            `You're selecting b-roll for this narration segment:\n"${s.text}"\n` +
            aspectText +
            `Choose the candidate that best fits: ` +
            `(1) semantic relevance, (2) visual clarity/framing, (3) motion/energy fit, (4) safe/brand-friendly, ` +
            `(5) orientation suitability for the target aspect(s).\n` +
            `Return strict JSON: {"best_index": <0-based integer>, "reason": "<short>"}`
        }
      ]

      candidates.forEach((c, i) => {
        const orient = c.width && c.height ? (c.width > c.height ? 'landscape' : (c.width < c.height ? 'portrait' : 'square')) : 'unknown'
        content.push({ type: 'text', text: `Candidate ${i} (id ${c.id}) – ${c.assetType.toUpperCase()}, ${orient}, ~${c.duration.toFixed(1)}s. Frames:` })
        c.frames.slice(0, FRAMES_PER_CANDIDATE).forEach((u: string) => {
          content.push({ type: 'image_url', image_url: { url: u } })
        })
      })

      const pickRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          reasoning_effort: 'high',
          verbosity: 'low'
        })
      })

      let bestIdx = 0
      if (pickRes.ok) {
        try {
          const pickJson = await pickRes.json()
          const parsed = JSON.parse(pickJson.choices[0].message.content)
          if (Number.isInteger(parsed.best_index)) bestIdx = clamp(parsed.best_index, 0, candidates.length - 1)
        } catch { /* fall back to 0 */ }
      }

      const chosen = candidates[bestIdx]
      const len = clamp(segLen, 1.5, chosen.duration || segLen)
      chosenClips.push({ src: chosen.src, start: s.start, length: len, assetType: chosen.assetType })
    }

    if (!chosenClips.length) return j({ error: 'no_clips_chosen' }, 400)

    // 7) Build Shotstack timelines (9:16 + 16:9) with soundtrack + captions
    const makeTimeline = (aspectRatio: '9:16' | '16:9') => ({
      timeline: {
        background: '#000000',
        soundtrack: { src: audioUrl, effect: 'fadeOut' },
        tracks: [
          {
            clips: chosenClips.map(c => ({
              asset: { type: c.assetType, src: c.src, ...(c.assetType === 'video' ? { trim: 0 } : {}) },
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

    return j({ jobs, audioUrl, captionsUrl, narration, model: OPENAI_MODEL })
  } catch (e: any) {
    return j({ error: 'server_error', message: e?.message || String(e) }, 500)
  }
}
