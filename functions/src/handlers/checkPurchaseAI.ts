import { HttpsError, onCall } from "firebase-functions/v2/https";
import Anthropic from "@anthropic-ai/sdk";
import { db, getSyncDoc } from "../lib/firestore.js";
import { ANTHROPIC_API_KEY } from "../lib/secrets.js";
import { getJstYearMonth0, monthKey } from "../lib/monthKey.js";
import type { Entry, SyncData, UnpaidManualItem } from "../lib/types.js";
import { FieldValue } from "firebase-admin/firestore";

const DAILY_LIMIT = 50;
const MODEL = "claude-haiku-4-5-20251001";

interface CheckPurchaseAIRequest {
  authToken?: unknown;
  amount?: unknown;
  category?: unknown;
}

interface BalanceData {
  accounts?: Array<{ id: number; name: string; balance: number }>;
  loans?: Array<{ id: number; name: string; balance: number; monthly: number; day: number }>;
  cards?: Array<{ id: number; name: string }>;
}

interface BudgetData {
  inc?: number;
  exp?: number;
  bizInc?: number;
  bizExp?: number;
  catBudgets?: Record<string, number>;
}

function getJstDateStr(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
}

// 今月キー（1-indexed月、YYYY-MM）。unpaidのmonthフィールドと同じ形式。
function currentMonthKey1indexed(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

function calcNetAvailable(data: SyncData, year: number, month0: number): {
  balance: number;
  expectedIncome: number;
  scheduledPayments: number;
  netAvailable: number;
} {
  const balanceData = (data.balance ?? {}) as BalanceData;
  const unpaid = (data.unpaid ?? []) as UnpaidManualItem[];

  // 口座残高合計
  const balance = (balanceData.accounts ?? []).reduce((s, a) => s + (a.balance ?? 0), 0);

  // 今月の収入見込み: business income で 入金済でなく、dueDate が今月以前のもの
  const mkey = monthKey(year, month0);
  const bizEntries: Entry[] = data.state.business.entries?.[mkey] ?? [];
  const todayStr = getJstDateStr();
  const thisMonth1 = currentMonthKey1indexed(year, month0);
  const expectedIncome = bizEntries
    .filter((e) => {
      if (e.type !== "income") return false;
      if (e.status === "入金済") return false;
      if (!e.dueDate) return false;
      // dueDate が今月中またはそれ以前（入金遅延分も含む）
      return e.dueDate.slice(0, 7) <= thisMonth1;
    })
    .reduce((s, e) => s + e.amount, 0);

  // 今月の支払い予定残り = ローン月返済額合計 + 今月の未払い合計
  const loanTotal = (balanceData.loans ?? []).reduce((s, l) => s + (l.monthly ?? 0), 0);
  const unpaidThisMonth = unpaid
    .filter((u) => u.month === thisMonth1)
    .reduce((s, u) => s + (u.amount ?? 0), 0);
  const scheduledPayments = loanTotal + unpaidThisMonth;

  return { balance, expectedIncome, scheduledPayments, netAvailable: balance + expectedIncome - scheduledPayments };
}

function buildRecentSpendingSummary(data: SyncData, year: number, month0: number): string {
  const mkey = monthKey(year, month0);
  const pEntries: Entry[] = data.state.personal.entries?.[mkey] ?? [];
  const todayStr = getJstDateStr();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(weekAgo);

  const recentBycat: Record<string, number> = {};
  for (const e of pEntries) {
    if (e.type !== "expense") continue;
    if (!e.date || e.date < weekAgoStr) continue;
    recentBycat[e.cat] = (recentBycat[e.cat] ?? 0) + e.amount;
  }
  const total = Object.values(recentBycat).reduce((s, v) => s + v, 0);
  if (total === 0) return "直近1週間の記録なし";
  const topLines = Object.entries(recentBycat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, amt]) => `${cat}¥${amt.toLocaleString("ja-JP")}`)
    .join("、");
  return `合計¥${total.toLocaleString("ja-JP")}（${topLines}）`;
}

// エミュレーター動作時はAnthropicを叩かずモックを返す
function isMockMode(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

export const checkPurchaseAI = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const data = request.data as CheckPurchaseAIRequest;
  const authToken = data.authToken;
  const amount = data.amount;
  const category = data.category;

  if (typeof authToken !== "string" || !authToken) {
    throw new HttpsError("invalid-argument", "authTokenが必要です");
  }
  if (typeof amount !== "number" || amount <= 0) {
    throw new HttpsError("invalid-argument", "amountが不正です");
  }
  if (typeof category !== "string" || !category) {
    throw new HttpsError("invalid-argument", "categoryが必要です");
  }

  const syncData = await getSyncDoc(authToken);
  if (!syncData) {
    throw new HttpsError("unauthenticated", "合言葉に対応するデータが見つかりません");
  }

  const { year, month0 } = getJstYearMonth0();
  const mkey = monthKey(year, month0);

  // 利用回数チェック（aiUsage サブコレクション）
  const todayStr = getJstDateStr();
  const usageDocRef = db
    .collection("cf-sync")
    .doc(authToken)
    .collection("aiUsage")
    .doc(todayStr);

  const usageSnap = await usageDocRef.get();
  const usageData = usageSnap.data();
  const currentCount: number = usageData?.count ?? 0;

  if (currentCount >= DAILY_LIMIT) {
    return { verdict: null, fallback: true };
  }

  // 使える余力を計算
  const { balance, expectedIncome, scheduledPayments, netAvailable } = calcNetAvailable(syncData, year, month0);

  // カテゴリ予算と使用済み額
  const budgetData = (syncData.budget ?? {}) as BudgetData;
  const budgetAmount: number = budgetData.catBudgets?.[category] ?? 0;
  const pEntries: Entry[] = syncData.state.personal.entries?.[mkey] ?? [];
  const usedAmount = pEntries
    .filter((e) => e.type === "expense" && e.cat === category)
    .reduce((s, e) => s + e.amount, 0);

  const recentSpendingSummary = buildRecentSpendingSummary(syncData, year, month0);

  // エミュレーターはモック応答
  if (isMockMode()) {
    await usageDocRef.set({ count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return {
      verdict: "caution",
      message: "【モック】エミュレーター動作中のため仮判定です",
      tip: "本番環境では実際のHaikuが判定します",
      fallback: false,
    };
  }

  // Anthropic Haiku 呼び出し
  const budgetLine = budgetAmount > 0
    ? `カテゴリ「${category}」予算:¥${budgetAmount.toLocaleString("ja-JP")}中¥${usedAmount.toLocaleString("ja-JP")}使用済み`
    : `カテゴリ「${category}」今月の使用額:¥${usedAmount.toLocaleString("ja-JP")}（予算未設定）`;

  const userPrompt = `【今月の実質使える余力】¥${netAvailable.toLocaleString("ja-JP")}
内訳: 口座残高¥${balance.toLocaleString("ja-JP")} + 収入見込み¥${expectedIncome.toLocaleString("ja-JP")} − 支払い予定残り¥${scheduledPayments.toLocaleString("ja-JP")}
${budgetLine}
直近1週間の支出傾向:${recentSpendingSummary}

【購入したいもの】¥${(amount as number).toLocaleString("ja-JP")}（カテゴリ: ${category}）
判定してください。`;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

  let rawText: string;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      system:
        'あなたは家計簿アプリの「買っていい？チェック」のAIアドバイザーです。\n必ず次のJSON形式のみで出力してください（他のテキストや説明、Markdown記法は一切禁止）:\n{"verdict":"go|caution|stop","message":"40字以内の理由","tip":"代替案があれば一言。なければ空文字"}',
      messages: [{ role: "user", content: userPrompt }],
    });
    rawText = msg.content[0].type === "text" ? msg.content[0].text : "";
  } catch (err) {
    console.error("checkPurchaseAI: Anthropic呼び出し失敗", err);
    return { verdict: null, fallback: true };
  }

  // JSONパース
  let parsed: { verdict: string; message: string; tip: string };
  try {
    // Markdownコードブロックが混入してもいいようにトリム
    const jsonStr = rawText.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(jsonStr);
    if (!["go", "caution", "stop"].includes(parsed.verdict)) throw new Error("invalid verdict");
  } catch {
    console.warn("checkPurchaseAI: JSONパース失敗", rawText);
    return { verdict: null, fallback: true };
  }

  // カウンターをインクリメント
  await usageDocRef.set({ count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return {
    verdict: parsed.verdict,
    message: parsed.message ?? "",
    tip: parsed.tip ?? "",
    fallback: false,
  };
});
