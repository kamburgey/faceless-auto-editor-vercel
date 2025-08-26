import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5'
const MAX_CANDIDATES = 5
const FRAMES_PER_CANDIDATE = 2

const clamp = (n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
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
    if (!process.env.PEXELS_API_KEY) return j({ error: 'missing_pexels_key' }, 500)
    if (!process.env.OPENAI_API_KEY) return j({ error: 'missing_openai_key' }, 500)

    const { segment, outputs } = await req.json() as {
      segment: {start:number; end:number; text:string},
      outputs?: {portrait?:boolean, landscape?:boolean}
    }
    if (!segment?.text || segment.end == null || segment.start == null) {
      return j({ error: 'bad_segment_payload' }, 400)
    }

    const headers = { Authorization: process.env.PEXELS_API_KEY as string }
    const segLen = clamp(segment.end - segment.start, 1.5, 7)

    // --- VIDEO CANDIDATES ---
    let candidates: Array<{
      id:number|string; src:string; duration:number; frames:string[];
      assetType:'video'|'image'; width?:number; height?:number
    }> = []
    try {
      const vr = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(segment.text)}&per_page=${MAX_CANDIDATES*2}`,
        { headers, cache: 'no-store' }
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
            id: v.id, src: file?.link, duration: v.duration || segLen,
            frames: frames.length ? frames : cover, assetType: 'video' as const,
            width: v.width, height: v.height
          }
        }).filter((c:any)=>!!c.src)
      }
