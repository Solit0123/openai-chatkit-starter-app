import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

// Load environment variables from .env* files when running locally.
if (!process.env.OPENAI_API_KEY) {
  const envCandidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env")
  ];

  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      loadEnv({ path: candidate, override: false });
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}