import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JudgeOutput } from '../types/index.js';

const judgeResult: JudgeOutput = {
  scoreA: 88,
  scoreB: 72,
  winner: 'A',
  reason: 'A 隊答案更貼近題目且完整。',
  breakdown: {
    A: { logic: 90, relevance: 88, completeness: 86, creativity: 88 },
    B: { logic: 72, relevance: 74, completeness: 70, creativity: 72 },
  },
};

describe('OpenAI AI adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps a non-empty topic description for every built-in topic', async () => {
    const { TOPICS, TOPIC_DESCRIPTIONS } = await import('./openai.js');

    expect(TOPICS.length).toBeGreaterThan(0);
    expect(TOPICS.filter((topic) => !TOPIC_DESCRIPTIONS[topic]?.trim())).toEqual([]);
  });

  it('calls the Responses API with the configured model and JSON schema format', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_MODEL', 'gpt-5.5');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify(judgeResult) }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { judge } = await import('./openai.js');
    const result = await judge({ topic: '冒煙測試', answerA: '答案一', answerB: '答案二' });

    expect(result).toEqual({ result: judgeResult, degraded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, any>;
    expect(body.model).toBe('gpt-5.5');
    expect(body.input[0].content).toContain('題目說明：在程式和軟件測試中，冒煙測試指初步進行快速測試');
    expect(body.input[0].content).toContain('題目符合度必須優先根據「題目說明」評估答案');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'word_chain_judge',
      strict: true,
    });
    expect(body.text.format.schema.required).toEqual([
      'scoreA',
      'scoreB',
      'winner',
      'reason',
      'breakdown',
    ]);
  });

  it('falls back when the OpenAI request fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_MODEL', 'gpt-5.5');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )),
    );

    const { judge } = await import('./openai.js');
    const result = await judge({ topic: '冒煙測試', answerA: '甲乙丙', answerB: '甲乙' });

    expect(result.degraded).toBe(true);
    expect(result.result.reason).toContain('評審服務暫時無法使用');
  });
});
