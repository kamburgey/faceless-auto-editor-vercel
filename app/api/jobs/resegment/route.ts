import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Segment = { start:number; end:number; text:string }
type Word = { start:number; end:number; word:string }

const SMART_BEATS = process.env.SMART_BEATS === '1'            // <— TOGGLE

const MIN_BEAT_SEC     = Number(process.env.MIN_BEAT_SEC      || 2.5)
const MAX_BEAT_SEC     = Number(process.env.MAX_BEAT_SEC      || 6.5)
const PAUSE_BREAK_SEC  = Number(process.env.PAUSE_BREAK_SEC    || 0.6)

function clip(n:number, lo:number, hi:number){ return Math.max(lo, Math.min(hi, n)) }

function buildChunksFromWords(words:Word[]){
  if (!words?.length) return []
  const chunks:{startIdx:number; endIdx:number; start:number; end:number; text:string}[] = []
  let curStartIdx = 0
  for (let i=1;i<words.length;i++){
    const gap = words[i].start - words[i-1].end
    const isPunct = /[.?!:,;]$/.test(words[i-1].word)
    if (gap >= PAUSE_BREAK_SEC || isPunct){
      const start = words[curStartIdx].start
      const end   = words[i-1].end
      const text  = words.slice(curStartIdx, i).map(w=>w.word).join(' ')
      if (text.trim()) chunks.push({ startIdx: curStartIdx, endIdx: i-1, start, end, text })
      curStartIdx = i
    }
  }
  // tail
  const start = words[curStartIdx].start
  const end   = words[words.length-1].end
  const text  = words.slice(curStartIdx).map(w=>w.word).join(' ')
  if (text.trim()) chunks.push({ startIdx: curStartIdx, endIdx: words.length-1, start, end, text })
  return chunks
}

function nearestWordTime(t:number, words:Word[]){
  if (!words.length) return t
  let best = words[0].start, bestD = Math.abs(t-best)
  for (const w of words){
    const c1 = w.start, c2 = w.end
    const d1 = Math.abs(t - c1), d2 = Math.abs(t - c2)
    if (d1 < bestD){ best = c1; bestD = d1 }
    if (d2 < bestD){ best = c2; bestD = d2 }
  }
  return best
}

// ---- Non-LLM, deterministic grouping (used when SMART_BEATS != 1) ----
function simpleBeatsFromChunks(chunks:ReturnType<typeof buildChunksFromWords>, words:Word[], audioLen:number, targetDurationSec?:number){
  if (!chunks.length) return [{ start: 0, end: audioLen, text: words.map(w=>w.word).join(' ') }]
  const idealBeat = clip(Number(targetDurationSec || audioLen) / 5, MIN_BEAT_SEC, MAX_BEAT_SEC)
  const desired   = clip(Math.round(audioLen / idealBeat), 3, 8)

  const beats:{start:number; end:number; text:string}[] = []
  let curStart = chunks[0].start
  let accText:string[] = []
  let accEnd = chunks[0].end
  let accDur = 0
  let i = 0

  while (i < chunks.length){
    const c = chunks[i]
    const addDur = c.end - (beats.length ? accEnd : curStart)
    const nextDur = accDur + addDur

    // decide to close the beat
    const shouldCloseBecauseMax = nextDur >= MAX_BEAT_SEC
    const longEnough            = nextDur >= MIN_BEAT_SEC
    const remainingChunks       = chunks.length - (i+1)
    const remainingBeatsTarget  = Math.max(1, desired - beats.length - 1)
    const mustCloseToReachTarget= remainingChunks <= remainingBeatsTarget // avoid too few beats at the end

    accText.push(c.text)
    accEnd = c.end
    accDur = nextDur
    i++

    if (shouldCloseBecauseMax || (longEnough && !mustCloseToReachTarget)) {
      const s = nearestWordTime(curStart, words)
      const e = nearestWordTime(accEnd, words)
      beats.push({ start: s, end: e, text: accText.join(' ').replace(/\s+/g,' ').trim() })
      // reset
      if (i < chunks.length){
        curStart = chunks[i].start
        accText = []
        accEnd = chunks[i].end
        accDur = 0
      }
    }
  }

  // tail if needed
  if (accText.length){
    const s = nearestWordTime(curStart, words)
    const e = nearestWordTime(Math.max(accEnd, s + MIN_BEAT_SEC), words)
    beats.push({ start: s, end: e, text: accText.join(' ').replace(/\s+/g,' ').trim() })
  }

  // clamp and ensure monotonic
  const fixed = beats.map(b => ({
    start: clip(b.start, 0, audioLen),
    end:   clip(b.end,   b.start + MIN_BEAT_SEC, audioLen),
    text:  b.text
  }))
  for (let k=1;k<fixed.length;k++){
    fixed[k].start = Math.max(fixed[k].start, fixed[k-1].end)
    fixed[k].end   = Math.max(fixed[k].end,   fixed[k].start + MIN_BEAT_SEC)
  }
  if (fixed.length) fixed[fixed.length-1].end = Math.max(fixed[fixed.length-1].end, Math.min(audioLen, fixed[fixed.length-1].start + MIN_BEAT_SEC))
  return fixed
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
    const chunks = buildChunksFromWords(words)

    // If LLM beats are OFF, return deterministic beats
    if (!SMART_BEATS) {
      const beats = simpleBeatsFromChunks(chunks, words, audioLen, targetDurationSec)
      return j({ beats })
    }

    // ----- LLM beat grouping (SMART_BEATS=1) -----
    const idealBeat = clip(Number(targetDurationSec || audioLen) / 5, MIN_BEAT_SEC, MAX_BEAT_SEC)
    const desiredBeats = clip(Math.round(audioLen / idealBeat), 3, 8)

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
    let beatsSpec:any[] = []
    try { beatsSpec = JSON.parse(out.choices[0].message.content || '{}').beats || [] } catch {}

    if (!beatsSpec.length) {
      // Fallback to deterministic if LLM returns nothing
      const beats = simpleBeatsFromChunks(chunks, words, audioLen, targetDurationSec)
      return j({ beats })
    }

    const beats:{start:number; end:number; text:string}[] = []
    for (const b of beatsSpec){
      const si = Math.max(0, Math.min(chunks.length-1, Number(b.start_index)))
      const ei = Math.max(si, Math.min(chunks.length-1, Number(b.end_index)))
      const s  = nearestWordTime(chunks[si].start, words)
      const e  = nearestWordTime(chunks[ei].end,   words)
      const t  = chunks.slice(si, ei+1).map(c=>c.text).join(' ').replace(/\s+/g,' ').trim()
      beats.push({ start:s, end:e, text:t })
    }

    // sanitize
    const fixed: { start:number; end:number; text:string }[] = []
    let cursor = 0
    for (const r of beats){
      let s = clip(Math.max(r.start, cursor), 0, audioLen)
      let e = clip(r.end, s + MIN_BEAT_SEC, audioLen)
      if (e - s > MAX_BEAT_SEC) e = s + MAX_BEAT_SEC
      fixed.push({ start: s, end: e, text: r.text })
      cursor = e
    }
    if (fixed.length) fixed[fixed.length-1].end = Math.max(fixed[fixed.length-1].end, Math.min(audioLen, fixed[fixed.length-1].start + MIN_BEAT_SEC))

    return j({ beats: fixed })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
