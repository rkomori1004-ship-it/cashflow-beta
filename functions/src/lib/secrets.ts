import { defineSecret } from "firebase-functions/params";

// Google AI StudioのGemini APIキー
export const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ③月末自動レポート専用：現在使用中の合言葉のSHA-256ハッシュ値（= cf-syncのdocId）。
// 合言葉を変更した場合はこの値も Secret Manager 側で更新すること。
export const SYNC_DOC_ID = defineSecret("SYNC_DOC_ID");
