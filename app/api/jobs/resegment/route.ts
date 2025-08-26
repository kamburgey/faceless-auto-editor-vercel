import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Segment = { start:number; end:number; text:string }
type Word = { start:number; end:number; word:string }

const SMART_BEATS = process.env.SMART_BEATS === '1'

const MIN_BEAT_SEC     = Number(process.env.MIN_BEAT_SEC      || 2.5)
const MAX_BEAT_SEC     = Number(process.env.MAX_BEAT_SEC      || 6.5)
const PAUSE_BREAK_SEC  = Number(process.env.PAUSE_BREAK_SEC    || 0.6)

const clip = (n:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, n))

function buildChunksFromWords(words:Word[]){
  if (!words?.length) return []
  const chunks:{startIdx:number; endIdx:number; start:number; end:number; text:string}[] = []
  let curStartIdx = 0
  for (let i=1;i<words.length;i++){
    const gap = words[i].start - words[i-1].end
    const punct = /[.?!:,;]$/.test(words[i-1].word)
    if (gap >= PAUSE_BREAK_SEC || punct){
      const start = words[curStartIdx].start
      const end   = words[i-1].end
      const text  = words.slice(curStartIdx, i).map(w=>w.word).join(' ')
      if (text.trim()) chunks.push({ startIdx: curStartIdx, endIdx: i-1, start, end, text })
      curStartIdx = i
    }
  }
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
    const pts = [w.start, w.end]
    for (const p of pts){
      const d = Math.abs(t - p)
      if (d < bestD){ best = p; bestD = d }
    }
  }
  return best
}

// deterministic beats when SMART_BEATS != 1
function simpleBeats(chunks:ReturnType<typeof buildChunksFromWords>, words:Word[], audioLen:number, targetDurationSec?:number){
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
    const nextDur = (accText.length ? (c.end - accEnd) : (c.end - curStart)) + accDur

    accText.push(c.text)
    accEnd = c.end
    accDur = nextDur
    i++

    const longEnough = accDur >= MIN_BEAT_SEC
    const hitMax     = accDur >= MAX_BEAT_SEC
    const remaining  = chunks.length - i
    const remBeats   = Math.max(1, desired - beats.length - 1)
    const forceClose = remaining <= remBeats

    if (hitMax || (longEnough && !forceClose)) {
      beats.push({ start: curStart, end: accEnd, text: accText.join(' ').replace(/\s+/g,' ').trim() })
      if (i < chunks.length){
        curStart = chunks[i].start
        accText = []
        accEnd = chunks[i].end
        accDur = 0
      }
    }
  }

  if (accText.length){
    beats.push({ start: curStart, end: Math.max(accEnd, curStart + MIN_BEAT_SEC), text: accText.join(' ').replace(/\s+/g,' ').trim() })
  }

  // sanitize + make contiguous + cover 0..audioLen exactly
  const fixed = beats.map(b => ({
    start: clip(b.start, 0, audioLen),
    end:   clip(b.end,   b.start + MIN_BEAT_SEC, audioLen),
    text:  b.text
  }))
  if (!fixed.length) return [{ start:0, end:audioLen, text: words.map(w=>w.word).join(' ') }]

  fixed[0].start = 0
  for (let k=1;k<fixed.length;k++){
    fixed[k].start = fixed[k-1].end
    fixed[k].end   = Math.max(fixed[k].end, fixed[k].start + MIN_BEAT_SEC)
    fixed[k].end   = Math.min(fixed[k].end, audioLen)
  }
  fixed[fixed.length-1].end = audioLen

  // snap to real word boundaries
  return fixed.map(b => ({
    start: nearestWordTime(b.start, words),
    end:   nearestWordTime(b.end,   words),
    text:  b.text
  }))
}

export async function POST(req: NextRequest){
  try {
    const { transcript, words, targetDurationSec } = await req.json() as {
      transcript: string
      words: Word[]
      targetDurationSec?: number
    }
    if (!words?.length) return j({ error:'missing_words' }, 400)

    const audioLen = words[words.length-1].end
    const chunks = buildChunksFromWords(words)

    if (!SMART_BEATS) {
      const beats = simpleBeats(chunks, words, audioLen, targetDurationSec)
      return j({ beats })
    }

    // LLM grouping
    const idealBeat = clip(Number(targetDurationSec || audioLen) / 5, MIN_BEAT_SEC, MAX_BEAT_SEC)
    const desiredBeats = clip(Math.round(audioLen / idealBeat), 3, 8)

    const chunkLines = chunks.map((c, i) => {
      const dur = (c.end - c.start).toFixed(2)
      const text = c.text.replace(/\s+/g,' ').slice(0,120)
      return `${i}. (${dur}s) ${text}`
    }).join('\n')

    const sys =
`You are a video editor. Group narration chunks into engaging SCENES (beats).
Keep original order, no overlaps. Prefer early hook, logical transitions, payoff.
Aim for ${desiredBeats} scenes total. Each scene ~${MIN_BEAT_SEC}–${MAX_BEAT_SEC}s.
Only merge adjacent chunks; do not split chunks.`

    const user =
`Chunks (index: duration text):
${chunkLines}

Return strict JSON:
{"beats":[{"start_index":<int>,"end_index":<int>,"label":"<short>"}]}`

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

    // Map to timed beats; sanitize, make contiguous, snap, and ensure full coverage
    if (!beatsSpec.length) return j({ beats: simpleBeats(chunks, words, audioLen, targetDurationSec) })

    const rough = beatsSpec.map(b => {
      const si = Math.max(0, Math.min(chunks.length-1, Number(b.start_index)))
      const ei = Math.max(si, Math.min(chunks.length-1, Number(b.end_index)))
      return { start: chunks[si].start, end: chunks[ei].end,
               text: chunks.slice(si, ei+1).map(c=>c.text).join(' ').replace(/\s+/g,' ').trim() }
    })

    // enforce contiguous coverage
    const fixed: { start:number; end:number; text:string }[] = []
    let cursor = 0
    for (const r of rough){
      let s = clip(Math.max(r.start, cursor), 0, audioLen)
      let e = clip(r.end, s + MIN_BEAT_SEC, audioLen)
      if (e - s > MAX_BEAT_SEC) e = s + MAX_BEAT_SEC
      fixed.push({ start: s, end: e, text: r.text })
      cursor = e
    }
    if (fixed.length) {
      fixed[0].start = 0
      for (let k=1;k<fixed.length;k++) fixed[k].start = fixed[k-1].end
      fixed[fixed.length-1].end = audioLen
    }

    const beats = fixed.map(b => ({
      start: nearestWordTime(b.start, words),
      end:   nearestWordTime(b.end,   words),
      text:  b.text
    }))

    return j({ beats })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
