import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o,{status:s})

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5'

export async function POST(req: NextRequest) {
  try {
    const { topic, niche, tone='Informative', targetDurationSec=30 } = await req.json()
    if (!topic || !niche) return j({error:'missing params'},400)

    // 1) narration
    const narrationPrompt =
`Write a ${targetDurationSec}s short-form voiceover about "${topic}" for the "${niche}" niche with a ${tone} tone.
Keep 110–150 words, punchy, high-retention. Output script only.`
    const narrRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model: OPENAI_MODEL, messages:[{role:'user', content:narrationPrompt}], reasoning_effort:'high', verbosity:'low' })
    })
    if (!narrRes.ok) return j({error:'openai_narration', details: await narrRes.text()}, 500)
    const narration = (await narrRes.json()).choices[0].message.content as string

    // 2) elevenlabs tts → mp3
    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,{
      method:'POST',
      headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY!, 'Content-Type':'application/json','Accept':'audio/mpeg'},
      body: JSON.stringify({ text:narration, model_id:'eleven_multilingual_v2', voice_settings:{stability:0.5, similarity_boost:0.8} })
    })
    if (!tts.ok) return j({error:'elevenlabs_tts', details: await tts.text()}, 500)
    const audioBuf = Buffer.from(await tts.arrayBuffer())

    // 3) upload mp3 to Blob (public)
    const { url: audioUrl } = await put(`audio/${Date.now()}.mp3`, audioBuf, { access:'public', token:process.env.BLOB_READ_WRITE_TOKEN })

    return j({ audioUrl, narration })
  } catch (e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
