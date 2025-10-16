import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getOAuthClient } from "@/app/lib/gmail/google";
import { loadKV, saveKV } from "@/app/lib/gmail/firestore";

type Provider = "gmail" | "calendar";

function isProvider(provider: unknown): provider is Provider {
  return provider === "gmail" || provider === "calendar";
}

function b64urlDecode<T = unknown>(value: string | null): T {
  if (!value) {
    throw new Error("missing_state");
  }
  const json = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(json) as T;
}

function pruneUndefined(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value === undefined) {
      delete (obj as Record<string, unknown>)[key];
    } else if (typeof value === "object" && value !== null) {
      pruneUndefined(value);
    }
  }
  return obj;
}

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get("code");
    const stateParam = searchParams.get("state");

    if (!code) {
      return new Response("Missing code", { status: 400 });
    }

    const state = b64urlDecode<{ provider: Provider; uid: string; tenantId?: string }>(stateParam);
    const { provider, uid, tenantId } = state;

    if (!isProvider(provider)) {
      return new Response("Invalid provider", { status: 400 });
    }

    const oauth = getOAuthClient(provider);
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return new Response(
        "Connected, but missing refresh_token. Please revoke the app at https://myaccount.google.com/permissions and connect again.",
        { status: 400 }
      );
    }

    const existing = ((await loadKV<Record<string, any>>("connections", uid)) ?? { tenantId }) as any;
    const updated: Record<string, unknown> = {};
    if (tenantId) updated.tenantId = tenantId;

    if (existing.gmail != null) updated.gmail = existing.gmail;
    if (existing.calendar != null) updated.calendar = existing.calendar;

    let gmailAddress: string | undefined;
    if (provider === "gmail") {
      try {
        const gmail = google.gmail({ version: "v1", auth: oauth });
        const profile = await gmail.users.getProfile({ userId: "me" });
        if (profile.data.emailAddress) {
          gmailAddress = profile.data.emailAddress.toLowerCase();
        }
      } catch (err) {
        console.error("gmail_profile_lookup_failed", err);
      }
    }

    const nextProviderPayload = {
      ...((existing as any)[provider] ?? {}),
      refresh_token: tokens.refresh_token,
      ...(gmailAddress ? { emailAddress: gmailAddress } : {}),
      ...(typeof tokens.scope === "string" ? { scopes: tokens.scope.split(" ") } : {}),
    };

    updated[provider] = nextProviderPayload;

    const cleaned = pruneUndefined(updated) as Record<string, unknown>;

    await saveKV("connections", uid, cleaned);
    if (provider === "gmail" && gmailAddress) {
      await saveKV("gmail_accounts", gmailAddress, { uid });
    }

    const redirectAfter = process.env.POST_OAUTH_REDIRECT_URL;
    if (redirectAfter) {
      return NextResponse.redirect(redirectAfter);
    }

    return new Response("Connected! You can close this tab.");
  } catch (error: any) {
    const details = error?.response?.data ?? { message: error?.message, stack: error?.stack };
    console.error("oauth_callback_failed", details);
    return new Response(
      `OAuth callback failed:\n${JSON.stringify(details, null, 2)}\n\nCheck redirect URI + env.`,
      {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }
    );
  }
}