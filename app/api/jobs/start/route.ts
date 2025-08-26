import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any))
    const topic = (body.topic ?? '').toString().trim()
    const niche = ((body.niche ?? 'General')).toString().trim() || 'General'
    const tone = (body.tone ?? 'Informative').toString().trim() || 'Informative'
    const targetDurationSec = Number(body.targetDurationSec ?? 30)

    if (!topic) return j({ error: 'missing_topic', details: 'Provide a topic' }, 400)

    // --- narration: emotive, VO-ready, short-form ---
    const sys = [
      'You are a senior YouTube/shorts scriptwriter.',
      'Write a compelling, voiceover-ready narration for a short-form video.',
      'Keep advertiser-friendly. Avoid unverifiable claims and tongue twisters.',
      'Style: cinematic but natural; vivid verbs; sensory details; emotional beats.',
      'Structure: powerful hook in the first line, clear progression, payoff/insight, concise outro/CTA.',
      'Formatting: short/medium sentences and paragraphs; no headings, bullets, timestamps, or scene labels.',
      `Target length: ~${targetDurationSec}s (~110–160 words).`,
    ].join(' ')

    const user = `Topic: "${topic}". Niche: ${niche}. Tone: ${tone}.
Write the final narration only.`

    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        reasoning_effort: 'medium',
        temperature: 0.8
      })
    })
    if (!narrRes.ok) return j({ error: 'openai_narration', details: await narrRes.text() }, 500)
    const narration = (await narrRes.json()).choices[0].message.content as string

    // --- TTS (model from env) ---
    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,{
      method:'POST',
      headers:{
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type':'application/json',
        'Accept':'audio/mpeg'
      },
      body: JSON.stringify({
        text: narration,
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.85 }
      })
    })
    if (!tts.ok) return j({ error:'elevenlabs_tts', details: await tts.text() }, 500)
    const audioBuf = Buffer.from(await tts.arrayBuffer())

    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, {
      access:'public', token: process.env.BLOB_READ_WRITE_TOKEN
    })

    return j({ audioUrl, narration })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
