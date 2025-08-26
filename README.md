
# Faceless Auto-Editor – Vercel-only starter

Single Next.js app that:
- calls OpenAI to draft a beat sheet,
- fetches stock clips from Pexels,
- renders via Shotstack (sandbox),
- returns a playable MP4 URL.

## Deploy on Vercel
1) Create a new GitHub repo and upload these files.
2) In Vercel: New Project → import the repo.
3) Add Environment Variables (Project Settings → Environment Variables):
   - `OPENAI_API_KEY`
   - `PEXELS_API_KEY`
   - `SHOTSTACK_API_KEY` (Sandbox key)
4) Deploy.

## Local dev
```
npm i
npm run dev
```
Create a `.env.local` file with the same env vars (never prefix with NEXT_PUBLIC since they must stay server-side).
