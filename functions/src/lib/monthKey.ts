// クライアント側 index.html の mkey(y, m) と完全に同じ規則で month key を作る。
// month は 0-indexed（1月=0, 12月=11）。この規則がずれると Firestore 上の
// entries と参照先が食い違ってしまうため、クライアントと必ず一致させること。

export function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0).padStart(2, "0")}`;
}

export function parseMonthKey(key: string): { year: number; month0: number } {
  const [y, m] = key.split("-");
  return { year: Number(y), month0: Number(m) };
}

export function previousMonthKey(year: number, month0: number): string {
  let py = year;
  let pm = month0 - 1;
  if (pm < 0) {
    pm = 11;
    py -= 1;
  }
  return monthKey(py, pm);
}

// Cloud FunctionsはUTCで動くため、日本時間の「今」の年・月(0-indexed)を明示的に取り出す
export function getJstYearMonth0(now: Date = new Date()): { year: number; month0: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month1 = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month0: month1 - 1 };
}

// 基準の月から遡って N ヶ月分の month key を新しい順で返す（基準月を含む）
export function recentMonthKeys(year: number, month0: number, count: number): string[] {
  const keys: string[] = [];
  let y = year;
  let m = month0;
  for (let i = 0; i < count; i++) {
    keys.push(monthKey(y, m));
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return keys;
}
