import { config } from '../config.js';
import { judgeOutputSchema, type JudgeOutput } from '../types/index.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const TOPICS = [
  '冒煙測試',
  '蜜罐',
  '小鴨測試',
  '金絲雀部署',
  '九頭蛇漏洞',
  '義大利麵條程式碼',
  '守門狗測試器',
  '上帝物件',
];

const criteriaSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    logic: { type: 'number' },
    relevance: { type: 'number' },
    completeness: { type: 'number' },
    creativity: { type: 'number' },
  },
  required: ['logic', 'relevance', 'completeness', 'creativity'],
};

const judgeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scoreA: { type: 'number' },
    scoreB: { type: 'number' },
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    reason: { type: 'string' },
    breakdown: {
      type: 'object',
      additionalProperties: false,
      properties: { A: criteriaSchema, B: criteriaSchema },
      required: ['A', 'B'],
    },
  },
  required: ['scoreA', 'scoreB', 'winner', 'reason', 'breakdown'],
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

/** Judge both answers. Returns { result, degraded } - never throws. */
export async function judge(
  args: JudgeArgs,
): Promise<{ result: JudgeOutput; degraded: boolean }> {
  if (config.openai.enabled) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callJudge(args);
        return { result, degraded: false };
      } catch (err) {
        console.warn(`[openai] judge attempt ${attempt + 1} failed:`, String(err));
      }
    }
  }
  return { result: fallbackJudge(args), degraded: true };
}

async function callJudge(args: JudgeArgs): Promise<JudgeOutput> {
  const prompt =
    '你是公正的 AI 評審。依下列權重評分（每項 0-100）：邏輯性25、題目符合度30、完整性25、創意性20。' +
    '依權重計算 A、B 兩隊總分（0-100）並選出勝隊。reason 為繁體中文、80 字內。只回傳符合 schema 的 JSON。\n' +
    `題目：${args.topic}\n` +
    `A 隊答案：${args.answerA}\n` +
    `B 隊答案：${args.answerB}`;

  const res = await fetchWithTimeout(
    OPENAI_RESPONSES_URL,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.openai.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openai.model,
        input: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        text: {
          format: {
            type: 'json_schema',
            name: 'word_chain_judge',
            strict: true,
            schema: judgeSchema,
          },
        },
      }),
    },
    15000,
  );

  const body = (await res.json()) as unknown;
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${extractErrorMessage(body)}`);
  }

  return judgeOutputSchema.parse(JSON.parse(extractOutputText(body)));
}

function extractOutputText(body: unknown): string {
  if (isRecord(body) && typeof body.output_text === 'string') {
    return body.output_text;
  }

  if (!isRecord(body) || !Array.isArray(body.output)) {
    throw new Error('OpenAI response did not include output text');
  }

  const parts: string[] = [];
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  const text = parts.join('').trim();
  if (!text) throw new Error('OpenAI response output text was empty');
  return text;
}

function extractErrorMessage(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return JSON.stringify(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
