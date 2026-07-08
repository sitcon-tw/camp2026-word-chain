import { config } from '../config.js';
import { judgeOutputSchema, type JudgeOutput } from '../types/index.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const TOPICS = [
  '冒煙測試',
  '蜜罐',
  '小鴨測試',
  '金絲雀部署',
  '九頭蛇漏洞',
  '義大利麵條程式碼',
  '守門狗定時器',
  '上帝物件',
];

export const TOPIC_DESCRIPTIONS: Record<string, string> = {
  冒煙測試:
    '在程式和軟件測試中，冒煙測試指初步進行快速測試，了解一個軟體的主要功能是否能夠正常運行。',
  蜜罐:
    '網管人員會故意在網路上架設一個看起來很有價值、防禦力很低的虛擬伺服器，用來吸引黑客前來攻擊。當黑客誤入這個陷阱時，資安人員就可以在不損害真實系統的情況下，偷偷觀察黑客的攻擊手法、收集他們的 IP 和工具。',
  小鴨測試:
    '當程式員遇到解不開的 Bug 時，會試著向一隻放在桌上的軟體橡膠小鴨，逐行解釋自己的程式碼在做什麼。神奇的是，在「向別人解釋」的過程中，大腦會重新理清邏輯，程式員往往講到一半就會自己發現錯誤在哪裡。',
  金絲雀部署:
    '當工程師開發了新功能，他們不會一次開放給所有用戶，而是先更新給極少數（例如 1%）的用戶試用。如果這 1% 的用戶沒有回報重大 Bug，才會逐步推廣到 100%。',
  九頭蛇漏洞:
    '有時候工程師為了修補一個底層的 A 漏洞，改動了核心程式碼，結果導致依賴這個底層的 B、C、D 功能同時崩潰，就像砍了一個頭卻長出更多頭一樣，讓人非常頭痛。',
  義大利麵條程式碼:
    '這通常是因為開發者大量使用不恰當的跳躍語句（如 goto），或者沒有做好模組化，導致邏輯像一盤攪在一起的義大利麵。你想拉出其中一根麵條（改動一個小功能），整盤麵都會跟著動（導致其他幾十個地方一起壞掉）。',
  守門狗定時器:
    '當系統正常運作時，程式必須定時去「餵狗」。如果系統因為當機（死鎖）而停止運作，沒人去餵狗，這隻狗倒數計時到零就會「咬人」——也就是直接強制把整台電腦硬體重啟（Reset），讓設備從當機中恢復。',
  上帝物件:
    '有些工程師喜歡把「所有功能」都寫在同一個檔案、同一個 Class 裡。這個 Class 無所不知、無所不能，既要處理使用者登入、又要控制資料庫、還要繪製介面，就像「上帝」一樣掌控一切。這種代碼極其臃腫，任何人想改動其中一小個功能，都要承受全盤崩潰的風險。',
};

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

export interface DegradedInfo {
  reason: 'quota' | 'rate_limit' | 'timeout' | 'auth' | 'invalid_response' | 'unknown';
  message: string;
}

/** Judge both answers. Returns { result, degraded } - never throws. */
export async function judge(
  args: JudgeArgs,
): Promise<{ result: JudgeOutput; degraded: boolean; degradedInfo?: DegradedInfo }> {
  if (config.openai.enabled) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callJudge(args);
        return { result, degraded: false };
      } catch (err) {
        console.warn(`[openai] judge attempt ${attempt + 1} failed:`, String(err));
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
      message: 'OpenAI API 未啟用或金鑰缺失，已改用本地備援評分。',
    },
  };
}

async function callJudge(args: JudgeArgs): Promise<JudgeOutput> {
  const topicDescription =
    TOPIC_DESCRIPTIONS[args.topic] ?? '無額外題目說明，請依題目名稱本身理解。';
  const prompt =
    '你是公正的 AI 評審。依下列權重評分（每項 0-100）：邏輯性25、題目符合度30、完整性25、創意性20。' +
    '依權重計算 A、B 兩隊總分（0-100）並選出勝隊。題目符合度必須優先根據「題目說明」評估答案是否真正貼合概念、情境與核心機制，而不是只看有沒有出現題目名稱或零碎關鍵字。reason 為繁體中文、80 字內。只回傳符合 schema 的 JSON。\n' +
    `題目：${args.topic}\n` +
    `題目說明：${topicDescription}\n` +
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

function classifyJudgeError(error: unknown): DegradedInfo {
  const text = String(error).toLowerCase();

  if (text.includes('timeout') || text.includes('abort')) {
    return {
      reason: 'timeout',
      message: 'OpenAI 評審逾時，已改用本地備援評分。',
    };
  }
  if (text.includes('429') || text.includes('rate limit')) {
    return {
      reason: 'rate_limit',
      message: 'OpenAI 請求過於頻繁，已改用本地備援評分。',
    };
  }
  if (text.includes('quota') || text.includes('insufficient_quota')) {
    return {
      reason: 'quota',
      message: 'OpenAI 額度不足，已改用本地備援評分。',
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
      message: 'OpenAI 驗證失敗或權限不足，已改用本地備援評分。',
    };
  }
  if (text.includes('json') || text.includes('schema') || text.includes('parse')) {
    return {
      reason: 'invalid_response',
      message: 'OpenAI 回傳格式異常，已改用本地備援評分。',
    };
  }

  return {
    reason: 'unknown',
    message: 'OpenAI 發生未知錯誤，已改用本地備援評分。',
  };
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
