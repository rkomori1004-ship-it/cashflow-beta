import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, getSyncDoc, reportDoc } from "../lib/firestore.js";
import { askGemini } from "../lib/gemini.js";
import { GEMINI_API_KEY, SYNC_DOC_ID } from "../lib/secrets.js";
import { buildMonthSummary, computeMonthStats } from "../lib/summary.js";
import { getJstYearMonth0, monthKey, parseMonthKey, previousMonthKey } from "../lib/monthKey.js";

export const generateMonthlyReport = onSchedule(
  {
    schedule: "10 9 1 * *",
    timeZone: "Asia/Tokyo",
    secrets: [GEMINI_API_KEY, SYNC_DOC_ID],
  },
  async () => {
    const syncDocId = SYNC_DOC_ID.value();
    if (!syncDocId) {
      console.error("generateMonthlyReport: SYNC_DOC_ID未設定のため処理をスキップします");
      return;
    }

    const syncData = await getSyncDoc(syncDocId);
    if (!syncData) {
      console.error("generateMonthlyReport: cf-syncドキュメントが見つかりません", { syncDocId });
      return;
    }

    const { year, month0 } = getJstYearMonth0();
    const prevKey = previousMonthKey(year, month0);
    const { year: prevYear, month0: prevMonth0 } = parseMonthKey(prevKey);

    const existing = await reportDoc(syncDocId, monthKey(prevYear, prevMonth0)).get();
    if (existing.exists) {
      console.log("generateMonthlyReport: 既に生成済みのためスキップします", { month: prevKey });
      return;
    }

    const monthDetail = buildMonthSummary(syncData, prevYear, prevMonth0);
    const stats = computeMonthStats(syncData, prevYear, prevMonth0);

    const prompt = `あなたは家計簿アプリ「Casshflow」のAIアドバイザーです。
以下は先月${prevYear}年${prevMonth0 + 1}月の家計・事業の収支データです。
振り返りレポートを作成してください。見出し付きで、良かった点・気になる点・来月への
具体的なアドバイスを含めてください。長すぎず、要点を絞ってください。

${monthDetail}`;

    let summaryText: string;
    try {
      summaryText = await askGemini(prompt);
    } catch (err) {
      console.error("generateMonthlyReport: Gemini呼び出し失敗", err);
      return; // 次回の手動リトライ等に委ねる。中途半端なレポートは保存しない
    }

    await reportDoc(syncDocId, monthKey(prevYear, prevMonth0)).set({
      summaryText,
      stats,
      generatedAt: FieldValue.serverTimestamp(),
    });
  },
);
