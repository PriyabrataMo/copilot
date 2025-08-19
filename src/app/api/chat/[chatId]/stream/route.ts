import { NextRequest } from "next/server";

// Simple proxy to existing /api/stream to provide /chat/:chatId/stream shape
export async function POST(req: NextRequest, context: { params: Promise<{ chatId: string }> }) {
  const params = await context.params;
  const body = await req.json().catch(() => ({}));
  const res = await fetch(new URL("/api/stream", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, conversationId: params.chatId }),
  });
  // Return the same streaming response as-is
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}


