import { OpenAI } from "openai";
import { requireEnv } from "@/app/lib/env";
import { firestore } from "@/app/lib/firebase-admin";

export type KnowledgeFile = {
  id: string;
  filename: string;
  bytes: number;
  status: string;
  last_processed_at?: string | null;
};

export type KnowledgeRecord = {
  vectorStoreId: string;
  files: KnowledgeFile[];
  updatedAt: string;
};

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

export async function getKnowledgeDoc(uid: string) {
  const doc = await firestore.collection("knowledge").doc(uid).get();
  return doc.exists ? (doc.data() as KnowledgeRecord) : null;
}

export async function setKnowledgeDoc(uid: string, data: Partial<KnowledgeRecord>) {
  const docRef = firestore.collection("knowledge").doc(uid);
  await docRef.set(
    {
      ...data,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

export async function getOrCreateVectorStoreForUser(uid: string) {
  const existing = await getKnowledgeDoc(uid);
  if (existing?.vectorStoreId) {
    return existing.vectorStoreId;
  }

  const vector = await openai.vectorStores.create({
    name: `user_${uid}_knowledge`,
  });

  await setKnowledgeDoc(uid, { vectorStoreId: vector.id, files: [] });
  return vector.id;
}

export async function refreshKnowledgeFiles(uid: string, vectorStoreId: string) {
  const files: KnowledgeFile[] = [];
  let cursor: string | undefined;

  do {
    const page = await openai.vectorStores.files.list(vectorStoreId, {
      after: cursor,
    });

    for (const file of page.data ?? []) {
      let filename = "untitled";
      let bytes = 0;
      let lastProcessed: string | null | undefined = (file as any).last_processed_at ?? null;

      if ("file_id" in file && typeof (file as any).file_id === "string") {
        try {
          const baseFile = await openai.files.retrieve((file as any).file_id);
          filename = baseFile.filename ?? filename;
          bytes = baseFile.bytes ?? bytes;
        } catch (err) {
          console.warn("knowledge_file_lookup_failed", err);
        }
      }

      files.push({
        id: file.id,
        filename,
        bytes,
        status: file.status ?? "unknown",
        last_processed_at: lastProcessed ?? null,
      });
    }

    if (page.has_more && page.data && page.data.length > 0) {
      cursor = page.data[page.data.length - 1]!.id;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  await setKnowledgeDoc(uid, { vectorStoreId, files });
  return files;
}