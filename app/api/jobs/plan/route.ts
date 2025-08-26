import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type Word = { start:number; end:number; word:string }

const MIN_BEAT = Number(process.env.MIN_BEAT_SEC || 1.7)
const MAX_BEAT = Number(process.env.MAX_BEAT_SEC || 3.8)

const actionVerbs = [
  'grind','pour','stir','mix','cut','chop','boil','brew','bloom','taste','sip','press','measure','heat','rinse','preheat','swirl','bloom'
]

function isBoundaryToken(w: string) {
  return /[.!?;:—-]$/.test(w.trim())
}

function preferVideo(text:string): boolean {
  const t = text.toLowerCase()
  return actionVerbs.some(v => t.includes(v))
}

export async function POST(req: NextRequest) {
  try {
    const { transcript, words } = await req.json() as { transcript: string, words: Word[] }
    if (!Array.isArray(words) || words.length === 0) return j({ beats: [] })

    const beats: { start:number; end:number; text:string; visualQuery:string; assetPreference:'video'|'image' }[] = []

    let curStart = words[0].start
    let curText: string[] = []
    let lastEnd = words[0].end

    function flushBeat(force=false) {
      if (!curText.length) return
      const text = curText.join(' ').replace(/\s+/g, ' ').trim()
      const start = curStart
      const end = lastEnd
      const dur = Math.max(0, end - start)
      if (!force && dur < MIN_BEAT) return // keep accumulating
      const pref = preferVideo(text) ? 'video' : 'image'
      beats.push({ start, end, text, visualQuery: text, assetPreference: pref })
      curText = []
    }

    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (curText.length === 0) curStart = w.start
      curText.push(w.word)
      lastEnd = w.end

      const duration = lastEnd - curStart
      const boundary = isBoundaryToken(w.word)

      if (duration >= MAX_BEAT || (boundary && duration >= MIN_BEAT)) {
        flushBeat(true)
      }
    }

    // flush remaining words; if the last beat is too long, split by time
    if (curText.length) {
      flushBeat(true)
    }

    // Split any overlong beats by time into ~MAX_BEAT chunks
    const normalized: typeof beats = []
    for (const b of beats) {
      const dur = b.end - b.start
      if (dur <= MAX_BEAT + 0.15) { normalized.push(b); continue }
      // split by time
      const target = Math.max(MIN_BEAT, Math.min(MAX_BEAT, (MIN_BEAT + MAX_BEAT)/2))
      const chunks = Math.max(2, Math.ceil(dur / target))
      const step = dur / chunks
      for (let k = 0; k < chunks; k++) {
        const s = b.start + step * k
        const e = k === chunks-1 ? b.end : (b.start + step * (k+1))
        normalized.push({
          start: s,
          end: e,
          text: b.text,
          visualQuery: b.visualQuery,
          assetPreference: b.assetPreference
        })
      }
    }

    return j({ beats: normalized })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
