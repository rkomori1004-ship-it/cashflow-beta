import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { SyncData } from "./types.js";

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export { FieldValue };

export async function getSyncDoc(syncDocId: string): Promise<SyncData | null> {
  const snap = await db.collection("cf-sync").doc(syncDocId).get();
  if (!snap.exists) return null;
  return snap.data() as SyncData;
}

export function chatMessagesCollection(syncDocId: string, month: string) {
  return db
    .collection("cf-sync")
    .doc(syncDocId)
    .collection("chatThreads")
    .doc(month)
    .collection("messages");
}

export function reportDoc(syncDocId: string, month: string) {
  return db.collection("cf-sync").doc(syncDocId).collection("reports").doc(month);
}
