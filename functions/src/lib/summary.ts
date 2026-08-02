import type { AppState, Entry, SyncData } from "./types.js";
import { monthKey, recentMonthKeys } from "./monthKey.js";

function getEntries(state: AppState, mode: "personal" | "business", year: number, month0: number): Entry[] {
  return state[mode].entries?.[monthKey(year, month0)] ?? [];
}

function sumByCat(entries: Entry[]): Record<string, number> {
  const cats: Record<string, number> = {};
  for (const e of entries) {
    cats[e.cat] = (cats[e.cat] ?? 0) + e.amount;
  }
  return cats;
}

function formatCatLines(cats: Record<string, number>): string {
  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  （記録なし）";
  return entries.map(([k, v]) => `  ・${k}: ¥${v.toLocaleString("ja-JP")}`).join("\n");
}

// index.html の getUnpaidItems() 相当（手動登録分＋支出記録で未払いフラグが立っているもの）
interface UnpaidLine {
  month: string;
  name: string;
  amount: number;
  cat: string;
  linkName?: string;
}

function collectUnpaidItems(data: SyncData): UnpaidLine[] {
  const manual: UnpaidLine[] = (data.unpaid ?? []).map((u) => ({
    month: u.month,
    name: u.name,
    amount: u.amount,
    cat: u.cat ?? "未分類",
    linkName: u.linkName,
  }));

  const auto: UnpaidLine[] = [];
  (["personal", "business"] as const).forEach((mode) => {
    const buckets = data.state[mode]?.entries ?? {};
    Object.entries(buckets).forEach(([bucketKey, arr]) => {
      arr.forEach((e) => {
        if (e.type === "expense" && e.paid === false) {
          auto.push({
            month: e.date ? e.date.slice(0, 7) : bucketKey,
            name: e.name,
            amount: e.amount,
            cat: e.cardId ? "クレジットカード" : mode === "business" ? "仕事の経費" : "家計の支出",
            linkName: e.cardName,
          });
        }
      });
    });
  });

  return [...manual, ...auto].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * index.html の buildAIConsultText() のサーバー側移植版。
 * 出力フォーマットは既存のコピペAI相談機能と揃えている。
 */
export function buildMonthSummary(data: SyncData, year: number, month0: number): string {
  const state = data.state;
  const pAll = getEntries(state, "personal", year, month0);
  const bAll = getEntries(state, "business", year, month0);
  const pE = pAll.filter((e) => e.type === "expense");
  const bE = bAll.filter((e) => e.type === "expense");
  const pInc = pAll.filter((e) => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const bInc = bAll.filter((e) => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const pExp = pE.reduce((s, e) => s + e.amount, 0);
  const bExp = bE.reduce((s, e) => s + e.amount, 0);

  const unpaidItems = collectUnpaidItems(data);
  const unpaidLines = unpaidItems.length
    ? unpaidItems
        .map((u) => `  ・${u.month} ${u.name}（${u.linkName || u.cat}）: ¥${u.amount.toLocaleString("ja-JP")}`)
        .join("\n")
    : "  （未払いなし）";
  const unpaidTotal = unpaidItems.reduce((s, u) => s + u.amount, 0);

  return `${year}年${month0 + 1}月の家計・収支データです。

【収入】
家計収入: ¥${pInc.toLocaleString("ja-JP")}
事業売上: ¥${bInc.toLocaleString("ja-JP")}

【家計の支出（カテゴリ別）】
${formatCatLines(sumByCat(pE))}
家計支出合計: ¥${pExp.toLocaleString("ja-JP")}

【事業の経費（カテゴリ別）】
${formatCatLines(sumByCat(bE))}
事業経費合計: ¥${bExp.toLocaleString("ja-JP")}

【純収支】
¥${(pInc + bInc - pExp - bExp).toLocaleString("ja-JP")}

【未払い一覧（クレカ・ローン・公共料金など、まだ払っていないもの）】
${unpaidLines}
未払い合計: ¥${unpaidTotal.toLocaleString("ja-JP")}`;
}

export interface MonthStats {
  income: number;
  expense: number;
  net: number;
  byCategory: Record<string, number>;
}

/** ③月末レポート保存用の集計値（家計＋事業を合算） */
export function computeMonthStats(data: SyncData, year: number, month0: number): MonthStats {
  const state = data.state;
  const pAll = getEntries(state, "personal", year, month0);
  const bAll = getEntries(state, "business", year, month0);
  const all = [...pAll, ...bAll];
  const income = all.filter((e) => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const expenseEntries = all.filter((e) => e.type === "expense");
  const expense = expenseEntries.reduce((s, e) => s + e.amount, 0);
  return { income, expense, net: income - expense, byCategory: sumByCat(expenseEntries) };
}

/**
 * 直近 count ヶ月分の「収入・支出・純収支」だけを軽量にまとめる。
 * カテゴリ内訳までは含めない（対話AIアドバイザーのトークン消費を抑えるため）。
 */
export function buildTrendSummary(data: SyncData, year: number, month0: number, count: number): string {
  const state = data.state;
  const keys = recentMonthKeys(year, month0, count);
  const lines = keys.map((key) => {
    const [y, m] = key.split("-").map(Number);
    const pAll = getEntries(state, "personal", y, m);
    const bAll = getEntries(state, "business", y, m);
    const inc = [...pAll, ...bAll].filter((e) => e.type === "income").reduce((s, e) => s + e.amount, 0);
    const exp = [...pAll, ...bAll].filter((e) => e.type === "expense").reduce((s, e) => s + e.amount, 0);
    return `  ・${y}年${m + 1}月: 収入¥${inc.toLocaleString("ja-JP")} / 支出¥${exp.toLocaleString("ja-JP")} / 純収支¥${(inc - exp).toLocaleString("ja-JP")}`;
  });
  return `【直近${count}ヶ月のトレンド（新しい月順）】\n${lines.join("\n")}`;
}
