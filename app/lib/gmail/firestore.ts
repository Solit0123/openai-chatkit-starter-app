import { firestore } from "../firebase-admin";

export async function loadKV<T = unknown>(col: string, id: string): Promise<T | null> {
  const doc = await firestore.collection(col).doc(id).get();
  return doc.exists ? (doc.data() as T) : null;
}

export async function saveKV(col: string, id: string, data: Record<string, unknown>): Promise<void> {
  await firestore.collection(col).doc(id).set(data, { merge: true });
}