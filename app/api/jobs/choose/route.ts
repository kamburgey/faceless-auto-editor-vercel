import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

// ---- config ----
const MAX_CANDIDATES = 6
const FRAMES_PER_CANDIDATE = 2
const SMART_PICK = process.env.SMART_PICK === '1'
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini'
const SMART_PICK_TIMEOUT_MS = Number(process.env.SMART_PICK_TIMEOUT_MS || 15000)

// ---- helpers ----
const clamp = (n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const pickSdFile = (v:any)=> (v?.video_files||[]).find((f:any)=>f.quality==='sd') ?? (v?.video_files||[])[0]
const framesFrom = (pics:any[], count:number)=>{
  if (!Array.isArray(pics) || !pics.length) return []
  if (pics.length<=count) return pics.map((p:any)=>p.picture)
  const step=Math.max(1,Math.floor(pics.length/count))
  const out:string[]=[]; for(let i=0;i<pics.length && out.length<count;i+=step) out.push(pics[i].picture)
  return out
}
function orientationOf(w?:number,h?:number){
  if (!w || !h) return 'unknown'
  if (w > h) return 'landscape'
  if (h > w) return 'portrait'
  return 'square'
}
type Cand = {
  id: number|string
  src: string
  assetType: 'video'|'image'
  width?: number
  height?: number
  duration?: number
  frames?: string[]
}
function scoreCandidate(c: Cand, want: 'portrait'|'landscape'|'any'){
  let s = 0
  const o = orientationOf(c.width, c.height)
  if (want !== 'any') {
    if (o === want) s += 3
    else if (o === 'square' || o === 'unknown') s += 1
  } else s += 1
  if (c.assetType === 'video') s += 2
  if (c.src) s += 1
  return s
}

// ---- main ----
export async function POST(req: NextRequest) {
  try {
    if (!process.env.PEXELS_API_KEY) return j({ error:'missing_pexels_key' }, 500)
    const { segment, outputs } = await req.json() as {
      segment: { start:number; end:number; text:string },
      outputs?: { portrait?: boolean, landscape?: boolean }
    }
    if (!segment?.text || segment.start==null || segment.end==null) return j({ error:'bad_segment_payload' }, 400)

    const segLen = clamp(segment.end - segment.start, 1.5, 7)
    const want: 'portrait'|'landscape'|'any' =
      outputs?.portrait && !outputs?.landscape ? 'portrait'
      : (!outputs?.portrait && outputs?.landscape) ? 'landscape'
      : 'landscape' // both -> lean landscape
    const headers = { Authorization: process.env.PEXELS_API_KEY as string }

    // 1) videos first
    let candidates: Cand[] = []
    try {
      const vr = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(segment.text)}&per_page=${MAX_CANDIDATES*2}`,
        { headers, cache:'no-store' }
      )
      if (vr.ok) {
        const vd = await vr.json()
        const uniq:any[] = []; const seen = new Set()
        for (const v of vd.videos || []) { if (seen.has(v.id)) continue; seen.add(v.id); uniq.push(v) }
        candidates = uniq.slice(0, MAX_CANDIDATES).map((v:any) => {
          const file = pickSdFile(v)
          const frames = framesFrom(v.video_pictures||[], FRAMES_PER_CANDIDATE)
          const cover = v.image ? [v.image] : []
          return {
            id:v.id, src:file?.link, assetType:'video' as const,
            width:v.width, height:v.height,
            duration:v.duration || segLen,
            frames: frames.length ? frames : cover
          }
        }).filter((c:any)=>!!c.src)
      }
    } catch {}

    // 2) fallback to photos
    if (!candidates.length) {
      try {
        const pr = await fetch(
          `https://api.pexels.com/v1/search?query=${encodeURIComponent(segment.text)}&per_page=${MAX_CANDIDATES}`,
          { headers, cache:'no-store' }
        )
        if (pr.ok) {
          const pd = await pr.json()
          candidates = (pd.photos || [])
            .map((p:any)=>({
              id:p.id,
              src: p.src?.original || p.src?.large2x || p.src?.large,
              assetType:'image' as const,
              width:p.width, height:p.height,
              duration: segLen,
              frames: [p.src?.medium || p.src?.large || p.src?.original].filter(Boolean)
            }))
            .filter((c:any)=>!!c.src)
        }
      } catch {}
    }

    if (!candidates.length) return j({ error:'no_candidates' }, 200)

    // 3) pick: either SMART (vision) or heuristic
    let chosenIdx = 0

    async function pickWithVision(): Promise<number> {
      const controller = new AbortController()
      const to = setTimeout(()=>controller.abort(), SMART_PICK_TIMEOUT_MS)
      try {
        const content:any[] = [{
          type:'text',
          text:`Pick the best b-roll for this narration segment:\n"${segment.text}"
Target aspect: ${want}. Score for: (1) semantic relevance, (2) framing clarity, (3) motion/energy fit, (4) safety/brand-friendly, (5) orientation suitability.
Return strict JSON: {"best_index": <0-based>, "reason": "<short>"}.`
        }]
        candidates.forEach((c,i)=>{
          const orient = orientationOf(c.width, c.height)
          content.push({ type:'text', text:`Candidate ${i} – ${c.assetType.toUpperCase()} · ${orient} · ~${(c.duration||segLen).toFixed(1)}s` })
          ;(c.frames||[]).slice(0, FRAMES_PER_CANDIDATE).forEach(u=> content.push({ type:'image_url', image_url:{ url:u } }))
        })

        const pickRes = await fetch('https://api.openai.com/v1/chat/completions',{
          method:'POST',
          headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [{ role:'user', content }],
            response_format: { type:'json_object' },
            reasoning_effort: 'low',
            temperature: 0
          }),
          signal: controller.signal
        })
        clearTimeout(to)
        if (!pickRes.ok) throw new Error(await pickRes.text())
        const pr = await pickRes.json()
        const parsed = JSON.parse(pr.choices[0].message.content)
        if (Number.isInteger(parsed.best_index)) return clamp(parsed.best_index, 0, candidates.length-1)
        return 0
      } catch {
        clearTimeout(to)
        return 0
      }
    }

    if (SMART_PICK && process.env.OPENAI_API_KEY) {
      chosenIdx = await pickWithVision()
      if (chosenIdx === 0) {
        // still give heuristic a chance if vision picked 0 due to failure or tie
        const idx = candidates
          .map((c, i) => ({ i, s: scoreCandidate(c, want) }))
          .sort((a,b)=>b.s-a.s)[0]?.i ?? 0
        chosenIdx = idx
      }
    } else {
      chosenIdx = candidates
        .map((c, i) => ({ i, s: scoreCandidate(c, want) }))
        .sort((a,b)=>b.s-a.s)[0]?.i ?? 0
    }

    const chosen = candidates[chosenIdx]
    const length = clamp(segLen, 1.5, chosen.duration || segLen)
    return j({ clip: { src: chosen.src, start: segment.start, length, assetType: chosen.assetType } })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
