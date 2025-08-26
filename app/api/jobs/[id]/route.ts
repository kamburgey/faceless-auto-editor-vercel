
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const r = await fetch(`https://api.shotstack.io/stage/render/${params.id}`, {
    headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY as string }
  })
  if (!r.ok) {
    const msg = await r.text().catch(()=> '')
    return NextResponse.json({ id: params.id, status: 'failed', message: msg }, { status: 200 })
  }
  const data = await r.json()
  return NextResponse.json({
    id: params.id,
    status: data.response?.status || 'unknown',
    url: data.response?.url || null,
    message: data.response?.message || null
  })
}
