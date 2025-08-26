import { NextRequest, NextResponse } from 'next/server'

export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
const j=(o:any,s=200)=>NextResponse.json(o,{status:s})

export async function POST(req: NextRequest) {
  try {
    const { clips, audioUrl, captionsUrl, outputs={portrait:true, landscape:true} } = await req.json() as {
      clips: { src:string; start:number; length:number; assetType:'video'|'image' }[]
      audioUrl: string
      captionsUrl: string
      outputs?: { portrait?: boolean; landscape?: boolean }
    }

    if (!clips?.length || !audioUrl || !captionsUrl) return j({error:'missing params'},400)

    const makeTimeline = (aspectRatio:'9:16'|'16:9') => ({
      timeline:{
        background:'#000000',
        soundtrack:{ src: audioUrl, effect:'fadeOut' },
        tracks:[
          { clips: clips.map(c=>({
              asset: { type:c.assetType, src:c.src, ...(c.assetType==='video'?{trim:0}:{}) },
              start:c.start, length:c.length, fit:'cover',
              transition:{ in:'fade', out:'fade' }
            }))
          },
          { clips: [{ asset:{ type:'caption', src: captionsUrl }, start:0, length: clips[clips.length-1].start + clips[clips.length-1].length + 0.5 }] }
        ]
      },
      output:{ format:'mp4', resolution:'hd', aspectRatio }
    })

    async function render(tl:any){
      const r = await fetch('https://api.shotstack.io/stage/render',{
        method:'POST',
        headers:{ 'x-api-key':process.env.SHOTSTACK_API_KEY!, 'Content-Type':'application/json' },
        body: JSON.stringify(tl)
      })
      const json = await r.json()
      return json?.response?.id as string|undefined
    }

    const jobs:any = {}
    if (outputs.portrait) jobs.portrait = await render(makeTimeline('9:16'))
    if (outputs.landscape) jobs.landscape = await render(makeTimeline('16:9'))

    return j({ jobs })
  } catch(e:any) {
    return j({error:'server_error', message:e?.message || String(e)},500)
  }
}
