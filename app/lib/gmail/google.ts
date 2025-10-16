// src/google.ts
import "dotenv/config";

import { google } from "googleapis";
import { loadKV, saveKV } from "@/app/lib/gmail/firestore";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
const REDIRECT = process.env.OAUTH_REDIRECT_URI!;

type Provider = "gmail" | "calendar";

function assertEnv(name: string, val?: string) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

export function getOAuthClient(provider: Provider) {
  assertEnv("GOOGLE_OAUTH_CLIENT_ID", CLIENT_ID);
  assertEnv("GOOGLE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
  assertEnv("OAUTH_REDIRECT_URI", REDIRECT);
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
}

// Each user keeps their own provider payload under connections/{uid}.
export async function saveTokens(uid: string, provider: Provider, tokens: Record<string, unknown>) {
  const existing = (await loadKV<Record<string, unknown>>("connections", uid)) ?? {};
  await saveKV("connections", uid, {
    ...existing,
    [provider]: tokens,
  });
}

export async function loadTokens(uid: string, provider: Provider) {
  const conn = await loadKV<Record<string, any>>("connections", uid);
  const rt = conn?.[provider]?.refresh_token as string | undefined;
  if (!rt) throw new Error(`missing_${provider}_refresh_token`);
  const oAuth2Client = getOAuthClient(provider);
  oAuth2Client.setCredentials({ refresh_token: rt });
  return oAuth2Client;
}

export async function getGmailClient(uid: string) {
  const auth = await loadTokens(uid, "gmail");
  return google.gmail({ version: "v1", auth });
}

export async function getCalendarClient(uid: string) {
  const auth = await loadTokens(uid, "calendar");
  return google.calendar({ version: "v3", auth });
}

export const getGmailClientFor = getGmailClient;
export const getCalendarClientFor = getCalendarClient;