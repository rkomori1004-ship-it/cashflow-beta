import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_API_KEY } from "./secrets.js";

// 無料枠のあるFlash系モデルを使用する（コストを抑える方針）
const MODEL_NAME = "gemini-2.0-flash";

export async function askGemini(prompt: string): Promise<string> {
  const client = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = client.getGenerativeModel({ model: MODEL_NAME });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  if (!text) {
    throw new Error("Gemini APIから空の応答が返されました");
  }
  return text;
}
