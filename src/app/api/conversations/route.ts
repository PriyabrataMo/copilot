import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_MODEL } from "@/src/lib/models";

export async function GET() {
  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, conversationId: true, title: true, model: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json(conversations);
}

export async function POST(req: NextRequest) {
  const { title, model } = await req.json().catch(() => ({ title: null, model: null }));
  const conversationId = uuidv4();
  const created = await prisma.conversation.create({
    data: {
      conversationId,
      title: title ?? "New Chat",
      model: model ?? DEFAULT_MODEL,
    },
  });
  return NextResponse.json(created);
}


