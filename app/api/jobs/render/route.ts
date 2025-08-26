import { NextRequest, NextResponse } from 'next/server'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
const j=(o:any,s=200)=>NextResponse.json(o,{status:s})

type Clip = { src:string; start:number; length:number; assetType:'video'|'image' }

function makeTimeline(audioUrl:string, clips:Clip[], aspectRatio:'9:16'|'16:9'){
  return {
    timeline: {
      background: '#000000',
      soundtrack: { src: audioUrl, effect: 'fadeOut', volume: 1 },
      tracks: [
        {
          clips: clips.map(c => ({
            asset: {
              type: c.assetType === 'image' ? 'image' : 'video',
              src: c.src,
              ...(c.assetType === 'video' ? { volume: 0 } : {}) // mute any source audio
            },
            start: c.start,
            length: c.length,
            fit: 'cover'
            // no transition -> hard cuts
          }))
        }
      ]
    },
    output: { format: 'mp4', resolution: 'hd', aspectRatio }
  }
}

async function renderShotstack(tl:any){
  const r = await fetch('https://api.shotstack.io/stage/render', {
    method:'POST',
    headers:{ 'x-api-key': process.env.SHOTSTACK_API_KEY!, 'Content-Type':'application/json' },
    body: JSON.stringify(tl)
  })
  const j = await r.json()
  return j?.response?.id as string | undefined
}

export async function POST(req: NextRequest) {
  try {
    const { clips, audioUrl, outputs } = await req.json() as {
      clips: Clip[], audioUrl: string, outputs?: { portrait?: boolean; landscape?: boolean }
    }
    if (!clips?.length) return j({error:'no_clips'},400)
    if (!audioUrl) return j({error:'missing_audioUrl'},400)

    const jobs: { portrait?: string; landscape?: string } = {}
    if (outputs?.portrait) jobs.portrait = await renderShotstack(makeTimeline(audioUrl, clips, '9:16'))
    if (outputs?.landscape) jobs.landscape = await renderShotstack(makeTimeline(audioUrl, clips, '16:9'))

    return j({ jobs })
  } catch (e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
