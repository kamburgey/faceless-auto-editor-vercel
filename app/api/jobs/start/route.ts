import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const ELEVEN_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5'
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || 'wBXNqKUATyqu0RtYt25i'

function cleanNarration(s: string, injectBreaths: boolean) {
  // Never use ellipses; turn them into commas/periods
  let t = s.replace(/…/g, ', ').replace(/\.\s*\.\s*\./g, '. ')
  // collapse whitespace
  t = t.replace(/\s{2,}/g, ' ').trim()
  // optional gentle pacing without "..."
  if (injectBreaths) {
    // add micro pauses after commas for TTS cadence
    t = t.replace(/, /g, ', ')
  }
  return t
}

function shapeForPace(text: string, pace: number) {
  // If slower pace requested, insert extra commas between clauses.
  if (pace <= 0.92) {
    return text.replace(/(\w)(\s)(\w)/g, (_m, a, _sp, b) => `${a}, ${b}`)
  }
  if (pace >= 1.08) {
    // faster: prefer shorter sentences by merging commas -> spaces
    return text.replace(/, /g, ' ')
  }
  return text
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { topic, niche, tone, targetDurationSec = 25, tts = {} } = body || {}
    if (!topic || !niche) return j({ error:'missing params' }, 400)

    const style: 'natural_conversational'|'narrator_warm'|'energetic' = tts.style || 'natural_conversational'
    const pace: number = typeof tts.pace === 'number' ? tts.pace : 0.95
    const breaths: boolean = !!tts.breaths
    const voiceId: string = tts.voiceId || DEFAULT_VOICE

    // 1) Narration (explicit tone/niche; forbid ellipses)
    const sys = [
      'You are a senior short-form scriptwriter for ads and social.',
      `Niche: ${niche}. Style/Tone: ${tone}. Advertiser-safe.`,
      `Target length: ~${Math.max(18, Math.min(40, targetDurationSec))} seconds.`,
      'Write a single, flowing voiceover script (no scene labels).',
      'Must have a hook up top, clear progression, and a crisp close.',
      'Natural cadence for TTS; avoid tongue twisters.',
      'Do NOT use ellipses or filler like "uh"—no "…".',
    ].join(' ')

    const user = `Topic: "${topic}". Write 110–150 words. Output voiceover only.`

    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      })
    })
    if (!narrRes.ok) return j({ error:'openai_narration', details: await narrRes.text() }, 500)
    let narration = (await narrRes.json()).choices[0].message.content as string
    narration = cleanNarration(narration, breaths)
    narration = shapeForPace(narration, pace)

    // 2) ElevenLabs TTS
    const styleMap: Record<string, number> = {
      natural_conversational: 0.15,
      narrator_warm: 0.35,
      energetic: 0.7
    }
    const styleNum = Math.max(0, Math.min(1, styleMap[style] ?? 0.15))

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: narration,
        model_id: ELEVEN_MODEL,
        // Use classic voice_settings – pace is shaped via text, not API
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.8,
          style: styleNum,
          use_speaker_boost: true
        }
      })
    })
    if (!ttsRes.ok) return j({ error:'elevenlabs_tts', details: await ttsRes.text() }, 500)
    const audioBuf = Buffer.from(await ttsRes.arrayBuffer())

    // 3) Upload audio to Blob (public)
    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    return j({ narration, audioUrl })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
