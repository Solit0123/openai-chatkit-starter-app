import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cert, getApps, getApp, initializeApp, applicationDefault } from "firebase-admin/app";
import type { ServiceAccount } from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function loadCredential() {
  const svcAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcAccount) {
    try {
      return cert(JSON.parse(svcAccount) as ServiceAccount);
    } catch (err) {
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT JSON");
    }
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const file = readFileSync(resolve(serviceAccountPath), "utf8");
    return cert(JSON.parse(file) as ServiceAccount);
  }

  return applicationDefault();
}

const credential = loadCredential();

const app = getApps().length ? getApp() : initializeApp({ credential });

export const firebaseAuth = getAuth(app);
export const firestore = getFirestore(app);