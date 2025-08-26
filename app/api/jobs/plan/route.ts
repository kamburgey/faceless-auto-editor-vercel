import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Word = { start:number; end:number; word:string }
type Beat = { start:number; end:number; text:string; visualQuery?:string; assetPreference?:'video'|'image' }

const SMART_STORYBOARD = process.env.SMART_STORYBOARD === '1'
const MIN_BEAT_SEC = Number(process.env.MIN_BEAT_SEC || 2.0)
const PAUSE_BREAK_SEC = Number(process.env.PAUSE_BREAK_SEC || 0.6)

const clip = (n:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, n))

function nearestWordTime(t:number, words:Word[]){
  if (!words.length) return t
  let best = words[0].start, bestD = Math.abs(t-best)
  for (const w of words){
    const pts = [w.start, w.end]
    for (const p of pts){
      const d = Math.abs(t - p)
      if (d < bestD){ best = p; bestD = d }
    }
  }
  return best
}

// Build sentences directly from word stream using punctuation or long pauses
function sentenceBeats(words:Word[], transcript:string): Beat[] {
  if (!words?.length) return []
  const audioLen = words[words.length-1].end
  const beats: Beat[] = []
  let startIdx = 0

  for (let i=1;i<words.length;i++){
    const prev = words[i-1]
    const gap = words[i].start - prev.end
    const punct = /[.?!]/.test(prev.word.slice(-1)) // strong sentence end
    if (gap >= PAUSE_BREAK_SEC || punct){
      const s = words[startIdx].start
      const e = prev.end
      if (e - s >= MIN_BEAT_SEC * 0.6) {
        const text = words.slice(startIdx, i).map(w => w.word).join(' ').replace(/\s+/g,' ').trim()
        beats.push({ start: s, end: e, text })
        startIdx = i
      }
    }
  }
  // tail
  if (startIdx < words.length){
    const s = words[startIdx].start
    const e = words[words.length-1].end
    const text = words.slice(startIdx).map(w => w.word).join(' ').replace(/\s+/g,' ').trim()
    if (text) beats.push({ start: s, end: e, text })
  }

  // normalize: contiguous 0..audioLen, snap to word boundaries
  if (!beats.length) return [{ start:0, end:audioLen, text: transcript.trim() }]
  beats[0].start = 0
  for (let k=1;k<beats.length;k++) beats[k].start = beats[k-1].end
  beats[beats.length-1].end = audioLen
  return beats.map(b => ({ start: nearestWordTime(b.start, words), end: nearestWordTime(b.end, words), text: b.text }))
}

export async function POST(req: NextRequest){
  try {
    const { transcript, words, niche, tone, targetDurationSec } = await req.json() as {
      transcript: string
      words: Word[]
      niche?: string
      tone?: string
      targetDurationSec?: number
    }
    if (!words?.length) return j({ error:'missing_words' }, 400)

    // Base: sentence-aligned beats
    const baseBeats = sentenceBeats(words, transcript)
    const audioLen = words[words.length-1].end

    // If storyboard OFF or no API key, return deterministic sentence beats
    if (!SMART_STORYBOARD || !process.env.OPENAI_API_KEY) {
      return j({ beats: baseBeats })
    }

    // LLM: turn each sentence into a visual intent + stock query
    const sys =
`You are a senior video editor planning B-ROLL. For each sentence, decide what the viewer should see.
Prioritize concrete visuals the audience expects (objects, actions, setting). Keep it brand-safe.
Return JSON only. Keys:
- idx: sentence index
- visual_query: short stock-search phrase (concrete nouns/verbs, 4–8 words)
- asset_preference: "video" or "image" (video for action, image if abstract)
Example: {"steps":[{"idx":0,"visual_query":"coffee beans spilling into trash can","asset_preference":"video"}]}`

    const sentences = baseBeats.map((b,i) => `${i}. ${b.text}`).join('\n')
    const user =
`Niche: ${niche || 'general'}
Tone: ${tone || 'informative'}
Target duration: ${Math.round(targetDurationSec || audioLen)}s

Sentences:
${sentences}

Return strict JSON: {"steps":[{"idx":<int>,"visual_query":"<phrase>","asset_preference":"video|image"}]}`
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role:'system', content: sys }, { role:'user', content: user }],
        response_format: { type:'json_object' },
        temperature: 0.2
      })
    })
    if (!r.ok) return j({ beats: baseBeats }) // safe fallback
    const out = await r.json()
    let steps:any[] = []
    try { steps = JSON.parse(out.choices[0].message.content || '{}').steps || [] } catch { steps = [] }

    const byIdx = new Map<number, {visual_query?:string; asset_preference?:'video'|'image'}>()
    for (const s of steps){
      const i = Number(s.idx)
      if (Number.isInteger(i)) byIdx.set(i, {
        visual_query: typeof s.visual_query === 'string' ? s.visual_query : undefined,
        asset_preference: s.asset_preference === 'video' || s.asset_preference === 'image' ? s.asset_preference : undefined
      })
    }

    const beats = baseBeats.map((b, i) => ({
      ...b,
      visualQuery: byIdx.get(i)?.visual_query || undefined,
      assetPreference: byIdx.get(i)?.asset_preference || undefined
    }))

    return j({ beats })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
