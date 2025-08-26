import { NextRequest, NextResponse } from 'next/server'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
const j=(o:any,s=200)=>NextResponse.json(o,{status:s})

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const MAX_CANDIDATES = 5
const FRAMES_PER_CANDIDATE = 2

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
const framesFrom = (pics:any[], count:number)=>{
  if (!Array.isArray(pics) || !pics.length) return []
  if (pics.length<=count) return pics.map((p:any)=>p.picture)
  const step=Math.max(1,Math.floor(pics.length/count))
  const out:string[]=[]; for(let i=0;i<pics.length && out.length<count;i+=step) out.push(pics[i].picture)
  return out
}
const pickSdFile=(v:any)=> (v?.video_files||[]).find((f:any)=>f.quality==='sd') ?? (v?.video_files||[])[0]

export async function POST(req: NextRequest) {
  try {
    const { segment, outputs } = await req.json() as { segment: {start:number; end:number; text:string}, outputs?: {portrait?:boolean, landscape?:boolean} }
    if (!segment?.text) return j({error:'missing segment'},400)

    const headers = { Authorization: process.env.PEXELS_API_KEY! }
    const segLen = clamp(segment.end - segment.start, 1.5, 7)

    // video candidates
    const vr = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(segment.text)}&per_page=${MAX_CANDIDATES*2}`,{ headers })
    let candidates: Array<{id:number|string; src:string; duration:number; frames:string[]; assetType:'video'|'image'; width?:number; height?:number}> = []
    if (vr.ok) {
      const vd = await vr.json()
      const uniq:any[] = []
      const seen=new Set()
      for (const v of vd.videos||[]) { if (seen.has(v.id)) continue; seen.add(v.id); uniq.push(v) }
      candidates = uniq.slice(0,MAX_CANDIDATES).map((v:any)=>{
        const file = pickSdFile(v)
        const frames = framesFrom(v.video_pictures||[], FRAMES_PER_CANDIDATE)
        const cover = v.image ? [v.image] : []
        return { id:v.id, src:file?.link, duration:v.duration||segLen, frames: frames.length?frames:cover, assetType:'video' as const, width:v.width, height:v.height }
      }).filter((c:any)=>!!c.src)
    }

    // photo fallback
    if (!candidates.length) {
      const pr = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(segment.text)}&per_page=${MAX_CANDIDATES}`,{ headers })
      if (pr.ok) {
        const pd = await pr.json()
        candidates = (pd.photos||[]).map((p:any)=>({
          id:p.id, src: p.src?.original || p.src?.large2x || p.src?.large,
          duration: segLen, frames: [p.src?.medium || p.src?.large || p.src?.original].filter(Boolean),
          assetType:'image' as const, width:p.width, height:p.height
        }))
        .filter((c:any)=>!!c.src)   // <-- typed param to avoid TS implicit-any error
      }
    }

    if (!candidates.length) return j({ error:'no_candidates' }, 200)

    // aspect hint
    const aspects:string[]=[]; if (outputs?.portrait) aspects.push('9:16'); if (outputs?.landscape) aspects.push('16:9')
    const aspectText = aspects.length ? `Target aspect ratio(s): ${aspects.join(' & ')}.` : ''

    // GPT-5 vision pick
    const content:any[] = [{
      type:'text',
      text:`Pick the best b-roll for this narration segment:\n"${segment.text}"\n${aspectText}
Score for (1) semantic relevance, (2) framing clarity, (3) motion/energy fit, (4) safety/brand-friendly, (5) orientation suitability.
Return strict JSON: {"best_index": <0-based>, "reason": "<short>"}`
    }]
    candidates.forEach((c,i)=>{
      const orient = c.width && c.height ? (c.width>c.height?'landscape':(c.width<c.height?'portrait':'square')) : 'unknown'
      content.push({ type:'text', text:`Candidate ${i} (id ${c.id}) – ${c.assetType.toUpperCase()}, ${orient}, ~${c.duration.toFixed(1)}s. Frames:` })
      c.frames.slice(0,FRAMES_PER_CANDIDATE).forEach(u=> content.push({ type:'image_url', image_url:{ url:u } }))
    })

    const pickRes = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, messages:[{role:'user', content}], response_format:{type:'json_object'}, reasoning_effort:'high', verbosity:'low' })
    })

    let bestIdx=0
    if (pickRes.ok) {
      try {
        const pickJson = await pickRes.json()
        const parsed = JSON.parse(pickJson.choices[0].message.content)
        if (Number.isInteger(parsed.best_index)) bestIdx = clamp(parsed.best_index, 0, candidates.length-1)
      } catch {}
    }

    const chosen = candidates[bestIdx]
    const length = clamp(segLen, 1.5, chosen.duration||segLen)
    return j({ clip: { src: chosen.src, start: segment.start, length, assetType: chosen.assetType } })
  } catch(e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
