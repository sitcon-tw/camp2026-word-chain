import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import { config } from '../config.js';
import {
  judgeOutputSchema,
  topicOutputSchema,
  type JudgeOutput,
} from '../types/index.js';

const client = config.gemini.enabled
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

const TOPICS = [
  '冒煙測試',
  '蜜罐',
  '小鴨測試',
  '金絲雀部署',
  '九頭蛇漏洞',
  '義大利麵條程式碼',
  '守門狗測試器',
  '上帝物件'
];

const criteriaSchema = {
  type: SchemaType.OBJECT,
  properties: {
    logic: { type: SchemaType.NUMBER },
    relevance: { type: SchemaType.NUMBER },
    completeness: { type: SchemaType.NUMBER },
    creativity: { type: SchemaType.NUMBER },
  },
  required: ['logic', 'relevance', 'completeness', 'creativity'],
} satisfies Schema;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

/** Generate a round topic. Falls back to a static pool on any failure. */
export async function pickTopic(): Promise<string> {
  return pick(TOPICS);
}

export interface JudgeArgs {
  topic: string;
  answerA: string;
  answerB: string;
}

export interface DegradedInfo {
  reason: 'quota' | 'rate_limit' | 'timeout' | 'auth' | 'invalid_response' | 'unknown';
  message: string;
}

/** Judge both answers. Returns { result, degraded } — never throws. */
export async function judge(
  args: JudgeArgs,
): Promise<{ result: JudgeOutput; degraded: boolean; degradedInfo?: DegradedInfo }> {
  if (client) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callJudge(args);
        return { result, degraded: false };
      } catch (err) {
        console.warn(`[gemini] judge attempt ${attempt + 1} failed:`, String(err));
        if (attempt === 1) {
          const degradedInfo = classifyJudgeError(err);
          return { result: fallbackJudge(args), degraded: true, degradedInfo };
        }
      }
    }
  }
  return {
    result: fallbackJudge(args),
    degraded: true,
    degradedInfo: {
      reason: 'auth',
      message: 'Gemini API 未啟用或金鑰缺失，已改用本地備援評分。',
    },
  };
}

async function callJudge(args: JudgeArgs): Promise<JudgeOutput> {
  const model = client!.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          scoreA: { type: SchemaType.NUMBER },
          scoreB: { type: SchemaType.NUMBER },
          winner: { type: SchemaType.STRING, enum: ['A', 'B', 'tie'] },
          reason: { type: SchemaType.STRING },
          breakdown: {
            type: SchemaType.OBJECT,
            properties: { A: criteriaSchema, B: criteriaSchema },
            required: ['A', 'B'],
          },
        },
        required: ['scoreA', 'scoreB', 'winner', 'reason', 'breakdown'],
      },
      temperature: 0.4,
    },
  });

  const prompt =
    '你是公正的 AI 評審。依下列權重評分（每項 0–100）：邏輯性25、題目符合度30、完整性25、創意性20。' +
    '依權重計算 A、B 兩隊總分（0–100）並選出勝隊。reason 為繁體中文、80 字內。只回傳符合 schema 的 JSON。\n' +
    `題目：${args.topic}\n` +
    `A 隊答案：${args.answerA}\n` +
    `B 隊答案：${args.answerB}`;

  const res = await withTimeout(model.generateContent(prompt), 15000);
  return judgeOutputSchema.parse(JSON.parse(res.response.text()));
}

/** Deterministic tiebreak so a judging failure never stalls the match. */
function fallbackJudge(args: JudgeArgs): JudgeOutput {
  const uniq = (s: string) => new Set([...s]).size;
  const a = uniq(args.answerA);
  const b = uniq(args.answerB);
  const scoreA = 50 + Math.min(40, a);
  const scoreB = 50 + Math.min(40, b);
  const winner = scoreA === scoreB ? 'tie' : scoreA > scoreB ? 'A' : 'B';
  const flat = { logic: 50, relevance: 50, completeness: 50, creativity: 50 };
  return {
    scoreA,
    scoreB,
    winner,
    reason: '（評審服務暫時無法使用，依答案豐富度自動評分）',
    breakdown: { A: { ...flat }, B: { ...flat } },
  };
}

function classifyJudgeError(error: unknown): DegradedInfo {
  const text = String(error).toLowerCase();

  if (text.includes('timeout')) {
    return {
      reason: 'timeout',
      message: 'Gemini 評審逾時，已改用本地備援評分。',
    };
  }
  if (text.includes('429') || text.includes('rate limit')) {
    return {
      reason: 'rate_limit',
      message: 'Gemini 請求過於頻繁，已改用本地備援評分。',
    };
  }
  if (text.includes('quota') || text.includes('resource_exhausted')) {
    return {
      reason: 'quota',
      message: 'Gemini 額度不足，已改用本地備援評分。',
    };
  }
  if (
    text.includes('api key') ||
    text.includes('permission') ||
    text.includes('unauthorized') ||
    text.includes('403') ||
    text.includes('401')
  ) {
    return {
      reason: 'auth',
      message: 'Gemini 驗證失敗或權限不足，已改用本地備援評分。',
    };
  }
  if (text.includes('json') || text.includes('schema') || text.includes('parse')) {
    return {
      reason: 'invalid_response',
      message: 'Gemini 回傳格式異常，已改用本地備援評分。',
    };
  }

  return {
    reason: 'unknown',
    message: 'Gemini 發生未知錯誤，已改用本地備援評分。',
  };
}

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
