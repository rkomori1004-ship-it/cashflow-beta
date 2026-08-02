// index.html のクライアント側データ構造をそのまま反映した型。
// 変更する場合は必ず index.html 側の実装と両方を更新すること。

export interface Entry {
  id: number;
  name: string;
  amount: number;
  type: "income" | "expense";
  cat: string;
  date?: string;
  status?: string;
  dueDate?: string;
  paid?: boolean;
  cardId?: string;
  cardName?: string;
  accountId?: string;
  accountName?: string;
}

export interface ModeState {
  month: number; // 0-indexed（JSのDate.getMonth()と同じ規則）
  year: number;
  entries: Record<string, Entry[]>; // key = mkey(year, month) = "{year}-{month(0-indexed) 2桁}"
}

export interface AppState {
  personal: ModeState;
  business: ModeState;
}

export interface UnpaidManualItem {
  id: string | number;
  month: string;
  name: string;
  amount: number;
  cat?: string;
  cardId?: string;
  loanId?: string;
  linkName?: string;
}

export interface SyncData {
  state: AppState;
  balance?: unknown;
  budget?: unknown;
  level?: unknown;
  unpaid?: UnpaidManualItem[] | null;
  templates?: unknown;
  goals?: unknown;
  allocation?: unknown;
  rewards?: unknown;
  factoring?: unknown;
  updatedAt: number;
}

export interface ChatMessage {
  role: "user" | "model";
  text: string;
  createdAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}
