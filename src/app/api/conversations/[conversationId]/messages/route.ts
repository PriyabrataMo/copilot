import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function GET(_: Request, context: { params: Promise<{ conversationId: string }> }) {
  const params = await context.params;
  const { conversationId } = params;
  const conv = await prisma.conversation.findUnique({ where: { conversationId } });
  if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ conversation: conv, messages });
}


