import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Word = { start:number; end:number; word:string }
type Beat = {
  start: number
  end: number
  text: string
  visualQuery: string
  assetPreference: 'video'|'image'
}

// --- config ---
const MIN_BEAT = Number(process.env.MIN_BEAT_SEC || 1.7)
const MAX_BEAT = Number(process.env.MAX_BEAT_SEC || 3.8)
const SMART_STORYBOARD = process.env.SMART_STORYBOARD === '1' // turn ON to use LLM
const OPENAI_STORYBOARD_MODEL =
  process.env.OPENAI_STORYBOARD_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'

// punctuation / boundary helpers
function isBoundaryToken(w: string) {
  return /[.!?;:—-]$/.test(w.trim())
}

function splitIntoSentences(words: Word[]) {
  const sentences: { start:number; end:number; text:string; idx:number }[] = []
  let cur: Word[] = []
  let sStart = words[0].start
  let idx = 0

  const flush = () => {
    if (!cur.length) return
    const text = cur.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim()
    const sEnd = cur[cur.length - 1].end
    sentences.push({ start: sStart, end: sEnd, text, idx })
    idx++
    cur = []
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (cur.length === 0) sStart = w.start
    cur.push(w)

    const dur = w.end - sStart
    const boundary = isBoundaryToken(w.word)

    // natural sentence break, or very long chunk
    if (boundary || dur >= Math.max(MAX_BEAT * 2.2, 8)) flush()
  }
  if (cur.length) flush()
  return sentences
}

function timeSliceBeat(b: Beat): Beat[] {
  const dur = b.end - b.start
  if (dur <= MAX_BEAT + 0.12) return [b]

  const target = Math.max(MIN_BEAT, Math.min(MAX_BEAT, (MIN_BEAT + MAX_BEAT) / 2))
  const chunks = Math.max(2, Math.ceil(dur / target))
  const step = dur / chunks
  const out: Beat[] = []
  for (let k = 0; k < chunks; k++) {
    const s = b.start + step * k
    const e = k === chunks - 1 ? b.end : (b.start + step * (k + 1))
    out.push({ ...b, start: s, end: e })
  }
  return out
}

// heuristic fallback if LLM is disabled or fails
function heuristicPreference(text: string): 'video'|'image' {
  const t = text.toLowerCase()
  const verbs = ['grind','pour','stir','mix','cut','chop','boil','brew','bloom','taste','sip','press','measure','heat','rinse','preheat','swirl']
  return verbs.some(v => t.includes(v)) ? 'video' : 'image'
}

export async function POST(req: NextRequest) {
  try {
    const { transcript, words, niche, tone } = await req.json() as {
      transcript: string, words: Word[], niche?: string, tone?: string
    }
    if (!Array.isArray(words) || words.length === 0) return j({ beats: [] })

    const sentences = splitIntoSentences(words)

    // Build LLM request only if enabled and key present
    let llmBeats: { idx:number, visual_query:string, asset_preference:'video'|'image' }[] | null = null

    if (SMART_STORYBOARD && process.env.OPENAI_API_KEY) {
      const sys =
        'You are a senior video editor. For each sentence, produce a concise stock-search visual brief.'
      const user =
`Niche: ${niche || 'general'}
Tone: ${tone || 'neutral'}

Return a strict JSON object with "beats": an array of:
{ "idx": <sentence index integer>,
  "visual_query": "<short search query for stock (nouns, verbs, setting, mood)>",
  "asset_preference": "video" | "image"
}

Guidance:
- Prefer "video" when the sentence depicts concrete actions, motion, human hands, liquids, or process steps.
- Prefer "image" when the sentence is abstract, summary, finished result, or static concept.
- Keep queries short (4–10 words). Avoid brand names, unsafe topics, faces unless generic, and avoid text overlays.
- Do NOT include time ranges; we already have timestamps.

Sentences:
${sentences.map(s => `- [${s.idx}] ${s.text}`).join('\n')}`

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: OPENAI_STORYBOARD_MODEL,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          response_format: { type: 'json_object' }
          // no temperature param to avoid model-specific restrictions
        })
      })

      if (r.ok) {
        try {
          const j = await r.json()
          const parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}')
          if (Array.isArray(parsed?.beats)) {
            llmBeats = parsed.beats
              .filter((b:any) => Number.isInteger(b.idx) && typeof b.visual_query === 'string')
              .map((b:any) => ({
                idx: Number(b.idx),
                visual_query: String(b.visual_query),
                asset_preference: (b.asset_preference === 'video' ? 'video' : 'image') as 'video'|'image'
              }))
          }
        } catch {
          llmBeats = null
        }
      }
    }

    // Merge LLM briefs with sentence timings; fallback to heuristic
    const rawBeats: Beat[] = sentences.map(s => {
      const llm = llmBeats?.find(b => b.idx === s.idx)
      const visualQuery = llm?.visual_query || s.text
      const assetPreference = llm?.asset_preference || heuristicPreference(s.text)
      return {
        start: s.start,
        end: s.end,
        text: s.text,
        visualQuery,
        assetPreference
      }
    })

    // Enforce min/max beat length by slicing long ones
    const beats: Beat[] = []
    for (const b of rawBeats) {
      const dur = Math.max(0, b.end - b.start)
      if (dur < MIN_BEAT && beats.length) {
        // merge tiny tail into previous beat
        const prev = beats[beats.length - 1]
        prev.end = b.end
        prev.text = `${prev.text} ${b.text}`.trim()
        // prefer "video" if either wants video
        prev.assetPreference = (prev.assetPreference === 'video' || b.assetPreference === 'video') ? 'video' : prev.assetPreference
        prev.visualQuery = prev.visualQuery // keep previous query
      } else {
        beats.push(...timeSliceBeat(b))
      }
    }

    return j({ beats })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
