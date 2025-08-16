import { NextRequest, NextResponse } from "next/server";
import { streamRegistry } from "@/src/lib/stream-registry";

export async function POST(req: NextRequest) {
  const { conversationId } = await req.json();
  if (!conversationId) return NextResponse.json({ ok: false }, { status: 400 });
  streamRegistry.stop(conversationId);
  return NextResponse.json({ ok: true });
}


