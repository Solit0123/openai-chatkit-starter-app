import { firebaseAuth } from "@/app/lib/firebase-admin";

export type FirebaseUser = {
  uid: string;
  tenantId?: string;
};

export async function getUserFromAuthorizationHeader(authHeader: string | null): Promise<FirebaseUser> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new Error("Authorization header missing token");
  }

  const decoded = await firebaseAuth.verifyIdToken(token);
  return { uid: decoded.uid, tenantId: decoded.tenantId };
}