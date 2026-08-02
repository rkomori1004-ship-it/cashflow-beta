import { HttpsError, onCall } from "firebase-functions/v2/https";
import { chatMessagesCollection, getSyncDoc } from "../lib/firestore.js";

const DELETE_BATCH_SIZE = 300;

interface ResetChatThreadRequest {
  syncDocId?: unknown;
  month?: unknown;
}

export const resetChatThread = onCall(async (request) => {
  const data = request.data as ResetChatThreadRequest;
  const syncDocId = data.syncDocId;
  const month = data.month;

  if (typeof syncDocId !== "string" || !syncDocId) {
    throw new HttpsError("invalid-argument", "syncDocIdが必要です");
  }
  if (typeof month !== "string" || !/^\d{4}-\d{1,2}$/.test(month)) {
    throw new HttpsError("invalid-argument", "monthの形式が不正です");
  }

  const syncData = await getSyncDoc(syncDocId);
  if (!syncData) {
    throw new HttpsError("unauthenticated", "合言葉に対応するデータが見つかりません");
  }

  const messagesRef = chatMessagesCollection(syncDocId, month);

  // 件数が多い場合を考慮し、ページングしながら削除する
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await messagesRef.limit(DELETE_BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = messagesRef.firestore.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < DELETE_BATCH_SIZE) break;
  }

  return { ok: true };
});
