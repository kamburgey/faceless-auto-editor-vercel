import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o: any, s = 200) => NextResponse.json(o, { status: s })

const MAX_CANDIDATES = 6
const FRAMES_PER_CANDIDATE = 2
const SMART_PICK = process.env.SMART_PICK === '1'
const SMART_QUERY = process.env.SMART_QUERY === '1'
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini'
const OPENAI_REWRITE_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini'
const SMART_PICK_TIMEOUT_MS = Number(process.env.SMART_PICK_TIMEOUT_MS || 15000)
const SMART_QUERY_TIMEOUT_MS = Number(process.env.SMART_QUERY_TIMEOUT_MS || 1500)

// strict coverage: ensure every beat is visually covered fully
const STRICT_COVERAGE = process.env.STRICT_COVERAGE !== '0' // default on

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

// SMART_QUERY rewrite
async function rewriteQuery(raw: string, want: 'portrait'|'landscape'|'any'): Promise<string> {
  if (!SMART_QUERY || !process.env.OPENAI_API_KEY) return raw
  const controller = new AbortController()
  const to = setTimeout(()=>controller.abort(), SMART_QUERY_TIMEOUT_MS)
  try {
    const sys = 'Extract 2–5 visual stock-search terms (objects, actions, setting, mood). Return JSON: {"terms":[...]}'
    const user = `Line: "${raw}"  Orientation: ${want}. Avoid abstract words; prefer concrete visuals.`
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_REWRITE_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    })
    clearTimeout(to)
    if (!r.ok) return raw
    const j = await r.json()
    const parsed = JSON.parse(j.choices[0].message.content || '{}')
    const terms: string[] = Array.isArray(parsed.terms) ? parsed.terms : []
    const q = terms.join(' ').trim()
    return q || raw
  } catch {
    clearTimeout(to)
    return raw
  }
}

// photo search helper
async function searchPhotoCandidate(query:string, headers:any, want:'portrait'|'landscape'|'any', segLen:number): Promise<Cand|null> {
  const orientationParam =
    want === 'portrait' ? '&orientation=portrait' :
    want === 'landscape' ? '&orientation=landscape' : ''
  const pr = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATES}${orientationParam}`,
    { headers, cache:'no-store' }
  )
  if (!pr.ok) return null
  const pd = await pr.json()
  const photos: Cand[] = (pd.photos || [])
    .map((p:any)=>({
      id:p.id,
      src: p.src?.original || p.src?.large2x || p.src?.large,
      assetType:'image' as const,
      width:p.width, height:p.height,
      duration: segLen,
      frames: [p.src?.medium || p.src?.large || p.src?.original].filter(Boolean)
    }))
    .filter((c:Cand)=>!!c.src)
  if (!photos.length) return null
  const idx = photos.map((c,i)=>({i,s:scoreCandidate(c,want)})).sort((a,b)=>b.s-a.s)[0]?.i ?? 0
  return photos[idx]
}

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
      : 'landscape'
    const headers = { Authorization: process.env.PEXELS_API_KEY as string }

    const baseQuery = await rewriteQuery(segment.text, want)

    // 1) videos first
    let candidates: Cand[] = []
    try {
      const vr = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(baseQuery)}&per_page=${MAX_CANDIDATES*2}`,
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
        }).filter((c:Cand)=>!!c.src)
      }
    } catch {}

    // 2) fallback to photos if no videos
    if (!candidates.length) {
      const photo = await searchPhotoCandidate(baseQuery, headers, want, segLen)
      if (photo) candidates = [photo]
    }

    if (!candidates.length) return j({ error:'no_candidates' }, 200)

    // 3) pick: SMART (vision) or heuristic
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
            model: OPENAI_VISION_MODEL,
            messages: [{ role:'user', content }],
            response_format: { type:'json_object' }
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
        const idx = candidates.map((c, i) => ({ i, s: scoreCandidate(c, want) }))
          .sort((a,b)=>b.s-a.s)[0]?.i ?? 0
        chosenIdx = idx
      }
    } else {
      chosenIdx = candidates.map((c, i) => ({ i, s: scoreCandidate(c, want) }))
        .sort((a,b)=>b.s-a.s)[0]?.i ?? 0
    }

    let chosen = candidates[chosenIdx]

    // ---- STRICT COVERAGE: if chosen video is shorter than the beat, auto-swap to a photo ----
    if (STRICT_COVERAGE && chosen.assetType === 'video' && (chosen.duration || 0) < segLen - 0.05) {
      const photo = await searchPhotoCandidate(baseQuery, headers, want, segLen)
      if (photo) chosen = photo
    }

    // Always return full beat length so there can be no gaps
    const length = segLen

    return j({ clip: { src: chosen.src, start: segment.start, length, assetType: chosen.assetType } })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
