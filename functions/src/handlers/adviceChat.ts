import { HttpsError, onCall } from "firebase-functions/v2/https";
import { chatMessagesCollection, FieldValue, getSyncDoc } from "../lib/firestore.js";
import { askGemini } from "../lib/gemini.js";
import { GEMINI_API_KEY } from "../lib/secrets.js";
import { buildMonthSummary, buildTrendSummary } from "../lib/summary.js";
import { parseMonthKey } from "../lib/monthKey.js";

const HISTORY_LIMIT = 20;
const TREND_MONTHS = 6;

interface AdviceChatRequest {
  syncDocId?: unknown;
  month?: unknown; // "yyyy-M"（0-indexed月、monthKey()の形式）
  question?: unknown;
}

export const adviceChat = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const data = request.data as AdviceChatRequest;
  const syncDocId = data.syncDocId;
  const month = data.month;
  const question = data.question;

  if (typeof syncDocId !== "string" || !syncDocId) {
    throw new HttpsError("invalid-argument", "syncDocIdが必要です");
  }
  if (typeof month !== "string" || !/^\d{4}-\d{1,2}$/.test(month)) {
    throw new HttpsError("invalid-argument", "monthの形式が不正です");
  }
  if (typeof question !== "string" || !question.trim()) {
    throw new HttpsError("invalid-argument", "questionが必要です");
  }

  const syncData = await getSyncDoc(syncDocId);
  if (!syncData) {
    throw new HttpsError("unauthenticated", "合言葉に対応するデータが見つかりません");
  }

  const { year, month0 } = parseMonthKey(month);

  const messagesRef = chatMessagesCollection(syncDocId, month);
  const historySnap = await messagesRef.orderBy("createdAt", "desc").limit(HISTORY_LIMIT).get();
  const history = historySnap.docs
    .map((d) => d.data() as { role: "user" | "model"; text: string })
    .reverse();

  const trend = buildTrendSummary(syncData, year, month0, TREND_MONTHS);
  const monthDetail = buildMonthSummary(syncData, year, month0);
  const historyText = history.length
    ? history.map((m) => `${m.role === "user" ? "ユーザー" : "AI"}: ${m.text}`).join("\n")
    : "（この月の会話はまだありません）";

  const prompt = `あなたは家計簿アプリ「Casshflow」のAIアドバイザーです。
以下のデータを踏まえて、簡潔かつ具体的に日本語でアドバイスしてください。
数字を挙げて指摘し、根拠のない一般論だけで終わらせないでください。

${trend}

${monthDetail}

【これまでの会話（この月のスレッド）】
${historyText}

【新しい質問】
${question}`;

  let answer: string;
  try {
    answer = await askGemini(prompt);
  } catch (err) {
    console.error("adviceChat: Gemini呼び出し失敗", err);
    throw new HttpsError("internal", "AIからの応答取得に失敗しました。時間をおいて再度お試しください");
  }

  // バッチ書き込みだと両方のserverTimestampが同一になり順序が不定になるため、
  // 順序を保証するために逐次書き込みする
  await messagesRef.add({ role: "user", text: question, createdAt: FieldValue.serverTimestamp() });
  await messagesRef.add({ role: "model", text: answer, createdAt: FieldValue.serverTimestamp() });

  return { answer };
});
