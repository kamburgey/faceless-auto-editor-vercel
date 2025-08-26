import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { url } = await put(`test/${Date.now()}.txt`, Buffer.from('hello'), {
    access: 'public',
    token: process.env.BLOB_READ_WRITE_TOKEN
  })
  return NextResponse.json({ ok: true, url })
}
