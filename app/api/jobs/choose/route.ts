import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

// ---- config ----
const MAX_CANDIDATES = 12
const FRAMES_PER_CANDIDATE = 2
const SMART_PICK = process.env.SMART_PICK === '1'
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'
const SMART_PICK_TIMEOUT_MS = Number(process.env.SMART_PICK_TIMEOUT_MS || 15000)

type AssetMode = 'ai' | 'image_only' | 'image_first' | 'video_first'
type Cand = {
  id: string
  src: string
  assetType: 'video'|'image'
  width?: number
  height?: number
  duration?: number
  frames?: string[]
  photographer?: string
}

const clamp = (n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const orientationOf = (w?:number,h?:number)=>{
  if (!w || !h) return 'unknown'
  if (w > h) return 'landscape'
  if (h > w) return 'portrait'
  return 'square'
}
const pickSdFile = (v:any)=> (v?.video_files||[]).find((f:any)=>f.quality==='sd') ?? (v?.video_files||[])[0]
const framesFrom = (pics:any[], count:number)=>{
  if (!Array.isArray(pics) || !pics.length) return []
  if (pics.length<=count) return pics.map((p:any)=>p.picture)
  const step=Math.max(1,Math.floor(pics.length/count))
  const out:string[]=[]; for(let i=0;i<pics.length && out.length<count;i+=step) out.push(pics[i].picture)
  return out
}
const uniqueBy = <T, K>(arr:T[], key:(x:T)=>K) => {
  const seen = new Set<K>()
  const out:T[] = []
  for (const it of arr) {
    const k = key(it)
    if (seen.has(k)) continue
    seen.add(k); out.push(it)
  }
  return out
}

function baseScore(c: Cand, want: 'portrait'|'landscape'|'any', mode: AssetMode){
  let s = 0
  const o = orientationOf(c.width, c.height)
  if (want !== 'any') {
    if (o === want) s += 4
    else if (o === 'square' || o === 'unknown') s += 2
  } else s += 1

  // mode preference
  if (mode === 'video_first' && c.assetType === 'video') s += 3
  if (mode === 'image_first' && c.assetType === 'image') s += 3
  // image_only handled by filtering, ai handled outside

  // basic quality
  if ((c.width||0) >= 720) s += 1
  if ((c.height||0) >= 1280 && o==='portrait') s += 1

  return s
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.PEXELS_API_KEY) return j({ error:'missing_pexels_key' }, 500)
    const body = await req.json() as {
      segment: { start:number; end:number; text:string }
      visualQuery?: string
      assetPreference?: 'video'|'image'
      outputs?: { portrait?: boolean, landscape?: boolean }
      assetMode?: AssetMode
      excludeIds?: Array<string|number>
    }
    const { segment, visualQuery, assetPreference, outputs, assetMode='ai' } = body
    const exclude = new Set((body.excludeIds||[]).map(String))

    if (!segment?.text || segment.start==null || segment.end==null) return j({ error:'bad_segment_payload' }, 400)

    const want: 'portrait'|'landscape'|'any' =
      outputs?.portrait && !outputs?.landscape ? 'portrait'
      : (!outputs?.portrait && outputs?.landscape) ? 'landscape'
      : 'landscape'

    const segLen = clamp(segment.end - segment.start, 1.8, 7)
    const headers = { Authorization: process.env.PEXELS_API_KEY as string }

    // ---------- candidate search (variety-aware) ----------
    const q = (visualQuery || segment.text).replace(/\s+/g, ' ').trim().slice(0, 120)

    // small randomization to avoid same first page results
    const randPage = 1 + Math.floor(Math.random() * 3)
    const perPage = 30

    let cand: Cand[] = []

    async function searchVideos(query:string) {
      const r = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${randPage}`,
        { headers, cache:'no-store' }
      )
      if (!r.ok) return []
      const d = await r.json()
      const items: Cand[] = (d.videos || []).map((v:any) => {
        const file = pickSdFile(v)
        const frames = framesFrom(v.video_pictures||[], FRAMES_PER_CANDIDATE)
        const cover = v.image ? [v.image] : []
        return {
          id: `v_${v.id}`,
          src: file?.link,
          assetType: 'video' as const,
          width: v.width, height: v.height,
          duration: v.duration || segLen,
          frames: frames.length ? frames : cover,
          photographer: v.user?.name
        }
      }).filter(x => !!x.src)
      return items
    }

    async function searchPhotos(query:string) {
      const r = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${randPage}`,
        { headers, cache:'no-store' }
      )
      if (!r.ok) return []
      const d = await r.json()
      const items: Cand[] = (d.photos || []).map((p:any) => ({
        id: `p_${p.id}`,
        src: p.src?.original || p.src?.large2x || p.src?.large,
        assetType: 'image' as const,
        width: p.width, height: p.height,
        duration: segLen,
        frames: [p.src?.medium || p.src?.large || p.src?.original].filter(Boolean),
        photographer: p.photographer
      })).filter(x => !!x.src)
      return items
    }

    // prefer based on mode / assetPreference
    const wantVideoFirst =
      assetMode === 'video_first' ||
      (assetMode === 'ai' && assetPreference === 'video')
    const wantImageOnly = assetMode === 'image_only'

    if (!wantImageOnly && wantVideoFirst) {
      cand = await searchVideos(q)
      if (cand.length < MAX_CANDIDATES) cand = cand.concat(await searchPhotos(q))
    } else if (wantImageOnly) {
      cand = await searchPhotos(q)
    } else {
      // image_first or ai with image preference
      cand = await searchPhotos(q)
      if (cand.length < MAX_CANDIDATES) cand = cand.concat(await searchVideos(q))
    }

    // de-dup & exclude used
    cand = uniqueBy(cand, c => c.id)
      .filter(c => !exclude.has(c.id))
    cand = uniqueBy(cand, c => c.src)

    if (!cand.length) return j({ error:'no_candidates' }, 200)

    // ---------- pick ----------
    const pickMode: AssetMode = (assetMode === 'ai' && assetPreference)
      ? (assetPreference === 'video' ? 'video_first' : 'image_first')
      : assetMode

    // heuristic baseline
    const ranked = cand
      .map((c, i) => {
        let s = baseScore(c, want, pickMode)
        // small variety bonus for new photographers
        if (c.photographer) s += 0.5
        return { i, s }
      })
      .sort((a,b)=>b.s-a.s)

    let choiceIdx = ranked[0].i

    // Try SMART_PICK (vision) if enabled
    if (SMART_PICK && process.env.OPENAI_API_KEY) {
      const controller = new AbortController()
      const to = setTimeout(()=>controller.abort(), SMART_PICK_TIMEOUT_MS)
      try {
        const top = ranked.slice(0, Math.min(MAX_CANDIDATES, 8)).map(x => cand[x.i])
        const content:any[] = [{
          type:'text',
          text:`Pick the best b-roll for:\n"${q}"\nAspect priority: ${want}. Prefer variety from previous picks (avoid duplicates).\nReturn {"best_index":<0-based>}.`
        }]
        top.forEach((c,i)=>{
          content.push({ type:'text', text:`Candidate ${i} – ${c.assetType} ${c.width}x${c.height}` })
          ;(c.frames||[]).slice(0,FRAMES_PER_CANDIDATE).forEach(u=>{
            content.push({ type:'image_url', image_url:{ url:u } })
          })
        })
        const resp = await fetch('https://api.openai.com/v1/chat/completions',{
          method:'POST',
          headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [{ role:'user', content }],
            response_format: { type:'json_object' },
            temperature: 0
          }),
          signal: controller.signal
        })
        clearTimeout(to)
        if (resp.ok) {
          const json = await resp.json()
          const parsed = JSON.parse(json.choices[0].message.content)
          const best = Number(parsed?.best_index)
          if (Number.isInteger(best) && best>=0 && best<top.length) {
            choiceIdx = cand.indexOf(top[best])
          }
        }
      } catch { /* fall back to heuristic */ }
    }

    // final guard: if selection somehow in exclude list (racey), move to next
    if (exclude.has(cand[choiceIdx].id)) {
      const fallback = ranked.find(r => !exclude.has(cand[r.i].id))
      if (fallback) choiceIdx = fallback.i
    }

    const chosen = cand[choiceIdx]
    const length = clamp(segLen, 1.8, chosen.duration || segLen)

    return j({
      clip: { src: chosen.src, start: segment.start, length, assetType: chosen.assetType },
      pickedId: chosen.id
    })
  } catch (e:any) {
    return j({ error:'server_error', message: e?.message || String(e) }, 500)
  }
}
