import { NextRequest, NextResponse } from "next/server";
import { getUserFromAuthorizationHeader } from "@/app/lib/firebase-auth";
import { loadKV } from "@/app/lib/gmail/firestore";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const { uid } = await getUserFromAuthorizationHeader(authHeader);

    const conn = (await loadKV<Record<string, any>>("connections", uid)) ?? {};
    const gmail = conn.gmail ?? {};
    const calendar = conn.calendar ?? {};

    return NextResponse.json({
      gmail: {
        connected: Boolean(gmail.refresh_token),
        scopes: gmail.scopes ?? [],
        historyId: gmail.historyId ?? null,
      },
      calendar: {
        connected: Boolean(calendar.refresh_token),
        scopes: calendar.scopes ?? [],
      },
    });
  } catch (err: any) {
    const isAuthError =
      err?.message === "Missing or invalid Authorization header" ||
      err?.message === "Authorization header missing token" ||
      (typeof err?.code === "string" && err.code.startsWith("auth/")) ||
      err?.name === "FirebaseAuthError";
    const status = isAuthError ? 401 : 500;
    return NextResponse.json({ error: err?.message ?? "Failed to load connections" }, { status });
  }
}