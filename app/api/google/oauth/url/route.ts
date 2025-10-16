import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient } from "@/app/lib/gmail/google";
import { getUserFromAuthorizationHeader } from "@/app/lib/firebase-auth";

type Provider = "gmail" | "calendar";

function isProvider(provider: string | null): provider is Provider {
  return provider === "gmail" || provider === "calendar";
}

function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export async function GET(req: NextRequest) {
  try {
    const providerParam = req.nextUrl.searchParams.get("provider");
    if (!isProvider(providerParam)) {
      return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
    }

    const authHeader = req.headers.get("authorization");
    const { uid, tenantId } = await getUserFromAuthorizationHeader(authHeader);

    const oauth = getOAuthClient(providerParam);
    const state = b64urlEncode({ provider: providerParam, uid, tenantId });
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: providerParam === "gmail"
        ? [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.modify",
          ]
        : [
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar",
          ],
      state,
    });

    return NextResponse.json({ url });
  } catch (error: any) {
    console.error("oauth_url_error", error);
    return NextResponse.json(
      { error: error?.message ?? "oauth_url_failed" },
      { status: 500 }
    );
  }
}