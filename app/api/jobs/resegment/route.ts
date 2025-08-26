import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Segment = { start:number; end:number; text:string }
type Word = { start:number; end:number; word:string }

const MIN_BEAT_SEC = Number(process.env.MIN_BEAT_SEC || 2.5)
const MAX_BEAT_SEC = Number(process.env.MAX_BEAT_SEC || 6.5)
const PAUSE_BREAK_SEC = Number(process.env.PAUSE_BREAK_SEC || 0.6)

function clip(n:number, lo:number, hi:number){ return Math.max(lo, Math.min(hi, n)) }

function buildChunksFromWords(words:Word[], transcript:string){
  if (!words?.length) return []
  const chunks:{startIdx:number; endIdx:number; start:number; end:number; text:string}[] = []
  let curStartIdx = 0
  for (let i=1;i<words.length;i++){
    const gap = words[i].start - words[i-1].end
    const prev = words[i-1].word
    const isPunct = /[.?!:,;]$/.test(prev)
    if (gap >= PAUSE_BREAK_SEC || isPunct){
      const start = words[curStartIdx].start
      const end = words[i-1].end
      const text = words.slice(curStartIdx, i).map(w=>w.word).join(' ')
      if (text.trim()) chunks.push({ startIdx: curStartIdx, endIdx: i-1, start, end, text })
      curStartIdx = i
    }
  }
  // tail
  const start = words[curStartIdx].start
  const end = words[words.length-1].end
  const text = words.slice(curStartIdx).map(w=>w.word).join(' ')
  if (text.trim()) chunks.push({ startIdx: curStartIdx, endIdx: words.length-1, start, end, text })
  return chunks
}

function nearestWordTime(t:number, words:Word[]){
  // snap t to nearest word boundary (start or end)
  if (!words.length) return t
  let best = words[0].start
  let bestD = Math.abs(t - best)
  for (const w of words){
    const c1 = w.start, c2 = w.end
    const d1 = Math.abs(t - c1), d2 = Math.abs(t - c2)
    if (d1 < bestD){ best = c1; bestD = d1 }
    if (d2 < bestD){ best = c2; bestD = d2 }
  }
  return best
}

export async function POST(req: NextRequest){
  try {
    const { transcript, segments, words, targetDurationSec } = await req.json() as {
      transcript: string
      segments: Segment[]
      words: Word[]
      targetDurationSec?: number
    }
    if (!words?.length) return j({ error:'missing_words' }, 400)

    const audioLen = words[words.length-1].end
    const chunks = buildChunksFromWords(words, transcript)
    if (!chunks.length) {
      // fallback: 1 beat covering full audio
      return j({ beats: [{ start: 0, end: audioLen, text: transcript.trim() }] })
    }

    // target beat count based on audio length
    const idealBeat = clip(Number(targetDurationSec || audioLen) / 5, MIN_BEAT_SEC, MAX_BEAT_SEC)
    const desiredBeats = clip(Math.round(audioLen / idealBeat), 3, 8)

    // Prepare compact chunk list for the LLM
    const chunkLines = chunks.map((c, i) => {
      const dur = (c.end - c.start).toFixed(2)
      const text = c.text.replace(/\s+/g,' ').slice(0,120)
      return `${i}. (${dur}s) ${text}`
    }).join('\n')

    const sys =
`You are a video editor. Group narration chunks into engaging SCENES (beats).
Keep original order, don't overlap. Prefer early hook, then logical transitions and payoff.
Aim for ${desiredBeats} scenes total. Each scene ~${MIN_BEAT_SEC}–${MAX_BEAT_SEC}s.
Only merge adjacent chunks; do not split chunks. Keep concise labels.`

    const user =
`Chunks (index: duration text):
${chunkLines}

Return strict JSON:
{"beats":[{"start_index":<int>,"end_index":<int>,"label":"<short>","why":"<brief>"}]}`

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
        messages: [{ role:'system', content: sys }, { role:'user', content: user }],
        response_format: { type:'json_object' }
      })
    })
    if (!resp.ok) return j({ error:'llm_failed', details: await resp.text() }, 500)
    const out = await resp.json()
    let beats = []
    try {
      const parsed = JSON.parse(out.choices[0].message.content || '{}')
      beats = Array.isArray(parsed.beats) ? parsed.beats : []
    } catch { beats = [] }

    if (!beats.length) {
      // simple fallback: spread evenly by duration constraints
      const even: {start:number; end:number; text:string}[] = []
      const segLen = clip(audioLen / desiredBeats, MIN_BEAT_SEC, MAX_BEAT_SEC)
      for (let i=0;i<desiredBeats;i++){
        const start = clip(i*segLen, 0, audioLen-0.1)
        const end = clip((i+1)*segLen, start+MIN_BEAT_SEC, audioLen)
        even.push({ start, end, text: transcript.slice(0,120) })
      }
      return j({ beats: even })
    }

    // Map chunk groups -> timed beats
    const result: { start:number; end:number; text:string; label?:string }[] = []
    for (const b of beats){
      const si = Math.max(0, Math.min(chunks.length-1, Number(b.start_index)))
      const ei = Math.max(si, Math.min(chunks.length-1, Number(b.end_index)))
      const start = nearestWordTime(chunks[si].start, words)
      const end = nearestWordTime(chunks[ei].end, words)
      const text = chunks.slice(si, ei+1).map(c=>c.text).join(' ').replace(/\s+/g,' ').trim()
      result.push({ start, end, text, label: typeof b.label === 'string' ? b.label : undefined })
    }

    // Sanity fix: monotonic, bounded, min/max duration
    const fixed: { start:number; end:number; text:string }[] = []
    let cursor = 0
    for (const r of result){
      let s = clip(Math.max(r.start, cursor), 0, audioLen)
      let e = clip(r.end, s + MIN_BEAT_SEC, audioLen)
      const len = e - s
      if (len > MAX_BEAT_SEC) e = s + MAX_BEAT_SEC
      fixed.push({ start: s, end: e, text: r.text })
      cursor = e
    }
    // ensure last covers to end minus a small tail if needed
    if (fixed.length) fixed[fixed.length-1].end = Math.max(fixed[fixed.length-1].end, Math.min(audioLen, fixed[fixed.length-1].start + MIN_BEAT_SEC))

    return j({ beats: fixed })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
