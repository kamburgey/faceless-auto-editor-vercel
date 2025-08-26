import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const ELEVEN_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5'

// ---- helpers ----
function clamp(n:number,min:number,max:number){ return Math.max(min, Math.min(max, n)) }

function mapVoiceSettings(style: string, pace: number, breaths: boolean) {
  // ElevenLabs expects 0..1 for all floats (style, stability, similarity_boost)
  // We also bias stability slightly lower if breaths=true to allow softer prosody.
  const stabBase = breaths ? 0.44 : 0.5
  if (style === 'energetic') {
    return { stability: clamp(stabBase + 0.04, 0, 1), similarity_boost: 0.75, style: 0.75 }
  }
  if (style === 'narrator_warm') {
    return { stability: clamp(stabBase + 0.02, 0, 1), similarity_boost: 0.80, style: 0.55 }
  }
  // natural_conversational
  return { stability: stabBase, similarity_boost: 0.80, style: 0.35 }
}

function postProcessForPace(text: string, pace: number, breaths: boolean) {
  const p = clamp(pace || 1, 0.85, 1.15)
  let t = text.trim()
  // encourage natural cadence for TTS
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ')
  t = t.replace(/([.!?])\s+/g, '$1\n')
  if (p < 0.98) {
    t = t.replace(/,\s/g, ', … ')
    t = t.replace(/:\s/g, ': … ')
  }
  if (breaths) {
    t = t.replace(/\.\n/g, '. …\n')
  }
  return t
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) return j({ error: 'missing_openai_key' }, 500)
    if (!process.env.ELEVENLABS_API_KEY) return j({ error: 'missing_elevenlabs_key' }, 500)
    if (!process.env.BLOB_READ_WRITE_TOKEN) return j({ error: 'missing_blob_token' }, 500)

    const body = await req.json()
    const {
      topic,
      niche = 'general',
      tone = 'neutral',
      targetDurationSec = 25,
      tts = {}
    } = body as {
      topic: string
      niche?: string
      tone?: string
      targetDurationSec?: number
      tts?: { voiceId?: string; style?: string; pace?: number; breaths?: boolean }
    }

    if (!topic) return j({ error: 'missing params' }, 400)

    // --- 1) Narration (tone + niche + pacing-aware word count) ---
    const pace = clamp(tts?.pace ?? 1.0, 0.85, 1.15)
    const wpmBase = 165
    const targetWPM = Math.round(wpmBase * pace)
    const targetWords = clamp(Math.round((targetDurationSec / 60) * targetWPM), 60, 230)

    const sys = 'You are a senior short-form video scriptwriter.'
    const user = [
      `Write a voiceover-ready script about "${topic}".`,
      `Niche: ${niche}. Tone: ${tone}. Style: ${tts?.style || 'natural_conversational'}.`,
      `Target read time: ~${targetDurationSec}s at ~${targetWPM} WPM (~${targetWords} words).`,
      'Make it punchy and human; use natural cadence, short lines, and commas for micro-pauses.',
      'No headings, no bullets, no scene labels — just the narration.',
      'Keep it advertiser-friendly.'
    ].join(' ')

    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
    })
    if (!narrRes.ok) return j({ error: 'openai_narration', details: await narrRes.text() }, 500)
    let narration = (await narrRes.json()).choices?.[0]?.message?.content?.trim() || ''
    narration = postProcessForPace(narration, pace, !!tts?.breaths)

    // --- 2) ElevenLabs TTS → MP3 ---
    const voiceId = (tts?.voiceId && String(tts.voiceId).trim()) || process.env.ELEVENLABS_VOICE_ID
    if (!voiceId) return j({ error: 'missing_voice_id' }, 500)

    const voice_settings = mapVoiceSettings(tts?.style || 'natural_conversational', pace, !!tts?.breaths)

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
        voice_settings
      })
    })
    if (!ttsRes.ok) return j({ error: 'elevenlabs_tts', details: await ttsRes.text() }, 500)
    const audioBuf = Buffer.from(await ttsRes.arrayBuffer())

    // --- 3) Upload audio → Blob (public) ---
    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    })

    return j({ narration, audioUrl })
  } catch (e:any) {
    return j({ error: 'server_error', message: e?.message || String(e) }, 500)
  }
}
