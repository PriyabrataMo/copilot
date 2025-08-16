import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function PATCH(req: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const params = await context.params;
  const body = await req.json().catch(() => ({}));
  const conv = await prisma.conversation.findUnique({ where: { conversationId: params.conversationId } });
  if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      title: body.title ?? conv.title,
      model: body.model ?? conv.model,
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const params = await context.params;
    const conv = await prisma.conversation.findUnique({ where: { conversationId: params.conversationId } });
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    
    // Delete all messages first (due to foreign key constraints)
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    
    // Then delete the conversation
    await prisma.conversation.delete({ where: { id: conv.id } });
    
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete conversation error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}


