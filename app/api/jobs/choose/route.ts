import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

// config
const MAX_CANDIDATES = 6
const FRAMES = 1
const SMART_PICK  = process.env.SMART_PICK === '1'
const SMART_QUERY = process.env.SMART_QUERY === '1'
const OPENAI_VISION_MODEL  = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_REWRITE_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const SMART_PICK_TIMEOUT_MS  = Number(process.env.SMART_PICK_TIMEOUT_MS  || 15000)
const SMART_QUERY_TIMEOUT_MS = Number(process.env.SMART_QUERY_TIMEOUT_MS || 1500)
const STRICT_COVERAGE = process.env.STRICT_COVERAGE !== '0' // default ON
const ASSET_MODE_ENV = (process.env.ASSET_MODE || 'image_first').toLowerCase() // env fallback

type Cand = { id:string|number; src:string; assetType:'video'|'image'; width?:number; height?:number; duration?:number; frames?:string[] }
const clamp = (n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const pickSd = (v:any)=> (v?.video_files||[]).find((f:any)=>f.quality==='sd') ?? (v?.video_files||[])[0]
const framesFrom = (pics:any[], k:number)=>!Array.isArray(pics)||!pics.length?[]:pics.slice(0, k).map((p:any)=>p.picture)
const orient = (w?:number,h?:number)=>!w||!h?'unknown':(w>h?'landscape':(h>w?'portrait':'square'))

function score(c:Cand, want:'portrait'|'landscape'|'any', segLen:number, prefer:'video'|'image'|null){
  let s = 0
  const o = orient(c.width, c.height)
  if (want!=='any') s += (o===want?3:(o==='square'||o==='unknown'?1:0)); else s+=1
  if (prefer && c.assetType===prefer) s += 3
  if (c.assetType==='video') {
    s += 2
    if ((c.duration||0) < segLen*0.85) s -= 3
  }
  if (c.src) s += 1
  return s
}

async function rewriteQuery(q:string){
  if (!SMART_QUERY || !process.env.OPENAI_API_KEY) return q
  const ctrl = new AbortController()
  const to = setTimeout(()=>ctrl.abort(), SMART_QUERY_TIMEOUT_MS)
  try{
    const sys = 'Extract 3–6 concrete stock-search terms (nouns/verbs, setting, mood). Return JSON: {"terms":[...]}'
    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: OPENAI_REWRITE_MODEL,
        messages:[{role:'system',content:sys},{role:'user',content:q}],
        response_format:{type:'json_object'},
        temperature:0.2
      }),
      signal: ctrl.signal
    })
    clearTimeout(to)
    if (!r.ok) return q
    const j = await r.json()
    const parsed = JSON.parse(j.choices[0].message.content||'{}')
    const terms: string[] = Array.isArray(parsed.terms) ? parsed.terms : []
    return terms.join(' ') || q
  } catch { clearTimeout(to); return q }
}

async function searchVideos(query:string, headers:any){
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATES*2}`, { headers, cache:'no-store' })
  if (!r.ok) return []
  const d = await r.json()
  const seen = new Set(); const out:Cand[]=[]
  for (const v of d.videos||[]){
    if (seen.has(v.id)) continue; seen.add(v.id)
    const file = pickSd(v); if (!file?.link) continue
    const fr = framesFrom(v.video_pictures||[], FRAMES)
    const cover = v.image ? [v.image] : []
    out.push({ id:v.id, src:file.link, assetType:'video', width:v.width, height:v.height, duration:v.duration||0, frames: fr.length?fr:cover })
    if (out.length>=MAX_CANDIDATES) break
  }
  return out
}
async function searchPhotos(query:string, headers:any){
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${MAX_CANDIDATES}`, { headers, cache:'no-store' })
  if (!r.ok) return []
  const d = await r.json()
  const out:Cand[] = (d.photos||[]).map((p:any)=>({
    id:p.id, src:p.src?.original||p.src?.large2x||p.src?.large, assetType:'image',
    width:p.width, height:p.height, duration:0, frames:[p.src?.medium||p.src?.large||p.src?.original].filter(Boolean)
  })).filter(c=>!!c.src)
  return out
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.PEXELS_API_KEY) return j({ error:'missing_pexels_key' }, 500)
    const { segment, outputs, visualQuery, assetPreference, assetMode } = await req.json() as {
      segment: { start:number; end:number; text:string },
      outputs?: { portrait?: boolean, landscape?: boolean },
      visualQuery?: string,
      assetPreference?: 'video'|'image',
      assetMode?: 'image_only'|'image_first'|'video_first' // <-- UI override
    }
    if (!segment?.text || segment.start==null || segment.end==null) return j({ error:'bad_segment_payload' }, 400)

    const segLen = Math.max(1.5, segment.end - segment.start)
    const want: 'portrait'|'landscape'|'any' =
      outputs?.portrait && !outputs?.landscape ? 'portrait'
      : (!outputs?.portrait && outputs?.landscape) ? 'landscape'
      : 'landscape'

    const headers = { Authorization: process.env.PEXELS_API_KEY as string }

    // Effective mode: UI override > env
    const mode = (assetMode || ASSET_MODE_ENV) as 'image_only'|'image_first'|'video_first'

    // Preference: if UI provided a mode, it wins; else defer to AI preference; else env default
    let prefer: 'video'|'image'|null = null
    if (assetMode) {
      prefer = mode === 'video_first' ? 'video' : 'image'
    } else if (assetPreference) {
      prefer = assetPreference
    } else {
      prefer = mode === 'video_first' ? 'video' : (mode === 'image_only' || mode === 'image_first' ? 'image' : null)
    }

    // Search order
    const tryPhotosFirst = assetMode
      ? (mode !== 'video_first')                   // UI says image_only/image_first => photos first
      : (assetPreference ? assetPreference==='image' : (ASSET_MODE_ENV !== 'video_first'))

    const baseQ = (visualQuery && visualQuery.trim()) ? visualQuery.trim() : segment.text
    const q = await rewriteQuery(baseQ)

    let candidates:Cand[] = []
    if (tryPhotosFirst) {
      candidates = await searchPhotos(q, headers)
      if (!candidates.length && mode !== 'image_only') candidates = await searchVideos(q, headers)
    } else {
      candidates = await searchVideos(q, headers)
      if (!candidates.length) candidates = await searchPhotos(q, headers)
    }

    if (!candidates.length) return j({ error:'no_candidates' }, 200)

    // pick
    let idx = 0
    async function pickVision(): Promise<number>{
      const ctrl = new AbortController()
      const to = setTimeout(()=>ctrl.abort(), SMART_PICK_TIMEOUT_MS)
      try {
        const content:any[] = [{
          type:'text',
          text:`Pick the most relevant b-roll for this narration segment: "${segment.text}"
Query: "${q}"
Preferred asset: ${prefer || 'none'}; Target aspect: ${want}.
Rank for: (1) semantic match, (2) clarity/framing, (3) motion/energy fit, (4) safety/brand-friendly, (5) orientation.
Return JSON: {"best_index": <0-based>}.`
        }]
        candidates.forEach((c,i)=>{
          content.push({ type:'text', text:`Candidate ${i} – ${c.assetType.toUpperCase()} • ${(c.duration||0).toFixed(1)}s` })
          ;(c.frames||[]).slice(0,1).forEach(u=> content.push({ type:'image_url', image_url:{ url:u } }))
        })
        const r = await fetch('https://api.openai.com/v1/chat/completions',{
          method:'POST',
          headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
          body: JSON.stringify({ model: OPENAI_VISION_MODEL, messages:[{role:'user',content}], response_format:{type:'json_object'} }),
          signal: ctrl.signal
        })
        clearTimeout(to)
        if (!r.ok) return 0
        const j = await r.json()
        const p = JSON.parse(j.choices[0].message.content || '{}')
        return Number.isInteger(p.best_index) ? clamp(p.best_index, 0, candidates.length-1) : 0
      } catch { clearTimeout(to); return 0 }
    }

    if (SMART_PICK && process.env.OPENAI_API_KEY) {
      idx = await pickVision()
      if (idx === 0) {
        idx = candidates.map((c,i)=>({i, s: score(c, want, segLen, prefer)})).sort((a,b)=>b.s-a.s)[0]?.i ?? 0
      }
    } else {
      idx = candidates.map((c,i)=>({i, s: score(c, want, segLen, prefer)})).sort((a,b)=>b.s-a.s)[0]?.i ?? 0
    }

    let chosen = candidates[idx]

    // Strict coverage: if video too short for this beat, swap to an image
    if (STRICT_COVERAGE && chosen.assetType==='video' && (chosen.duration||0) < segLen-0.05) {
      const photos = await searchPhotos(q, headers)
      if (photos.length) chosen = photos[0]
    }

    return j({ clip: { src: chosen.src, start: segment.start, length: segLen, assetType: chosen.assetType } })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
