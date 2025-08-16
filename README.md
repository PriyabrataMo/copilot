## ChatGPT-like Minimal Clone

Minimal ChatGPT-like clone with Next.js App Router, MongoDB via Prisma, SSE streaming, and chat UI with Stop/Regenerate.

### Setup

1. Copy `.env.example` to `.env.local` and fill values
2. Install deps: `pnpm install`
3. Generate Prisma client: `pnpm dlx prisma generate`
4. Dev: `pnpm dev`

### Features

- Conversations persisted in MongoDB with Prisma
- SSE streaming with Stop/Regenerate
- Model selector per conversation
- Token-aware context window using tiktoken
