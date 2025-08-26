import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const j = (o:any, s=200) => NextResponse.json(o, { status: s })

type ClipIn = { src:string; start:number; length:number; assetType:'video'|'image' }

function timelineFor(aspect:'9:16'|'16:9', clips: ClipIn[], audioUrl:string) {
  return {
    timeline: {
      background: '#000000',
      soundtrack: { src: audioUrl, effect: 'none' }, // no fade
      tracks: [
        {
          clips: clips.map(c => ({
            asset:
              c.assetType === 'image'
                ? { type:'image', src:c.src }
                : { type:'video', src:c.src, volume:0 }, // mute native audio
            start: c.start,
            length: c.length,
            fit: 'cover',
            position: 'center'
          }))
        }
        // captions track deliberately omitted (we still upload SRT separately if you want it later)
      ]
    },
    output: { format: 'mp4', resolution: 'hd', aspectRatio: aspect }
  }
}

async function renderWithShotstack(tl:any, key:string) {
  const r = await fetch('https://api.shotstack.io/stage/render', {
    method:'POST',
    headers:{ 'x-api-key': key, 'Content-Type':'application/json' },
    body: JSON.stringify(tl)
  })
  const j = await r.json()
  return j?.response?.id as string | undefined
}

export async function POST(req: NextRequest) {
  try {
    const { clips, audioUrl, outputs } = await req.json() as {
      clips: ClipIn[],
      audioUrl: string,
      outputs: { portrait?: boolean, landscape?: boolean }
    }
    if (!Array.isArray(clips) || !clips.length) return j({ error:'no_clips' }, 400)
    if (!audioUrl) return j({ error:'no_audio' }, 400)
    if (!process.env.SHOTSTACK_API_KEY) return j({ error:'missing_shotstack_key' }, 500)

    const jobs: { portrait?: string; landscape?: string } = {}
    if (outputs?.portrait) {
      const tl = timelineFor('9:16', clips, audioUrl)
      jobs.portrait = await renderWithShotstack(tl, process.env.SHOTSTACK_API_KEY!)
    }
    if (outputs?.landscape) {
      const tl = timelineFor('16:9', clips, audioUrl)
      jobs.landscape = await renderWithShotstack(tl, process.env.SHOTSTACK_API_KEY!)
    }
    return j({ jobs })
  } catch (e:any) {
    return j({ error:'server_error', message:e?.message || String(e) }, 500)
  }
}
