import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function DELETE(_req: NextRequest, context: { params: Promise<{ messageId: string }> }) {
  const params = await context.params;
  const msg = await prisma.message.findUnique({ where: { messageId: params.messageId } });
  if (!msg) return NextResponse.json({ ok: false }, { status: 404 });
  await prisma.message.delete({ where: { messageId: params.messageId } });
  return NextResponse.json({ ok: true });
}


