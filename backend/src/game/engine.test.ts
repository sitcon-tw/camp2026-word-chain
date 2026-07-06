import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameEngine } from './engine.js';
import { canAdvanceSeatManually } from './rules.js';

vi.mock('../state/roomRepo.js', () => ({
  saveRoom: vi.fn().mockResolvedValue(undefined),
  loadPlayers: vi.fn().mockResolvedValue([]),
  savePlayer: vi.fn().mockResolvedValue(undefined),
  deletePlayer: vi.fn().mockResolvedValue(undefined),
  clearEvents: vi.fn().mockResolvedValue(undefined),
  pushEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ai/gemini.js', () => ({
  pickTopic: vi.fn().mockResolvedValue('測試題目'),
  judge: vi.fn().mockResolvedValue({
    result: {
      scoreA: 50,
      scoreB: 40,
      winner: 'A',
      reason: 'mock judge',
      breakdown: {
        A: { logic: 50, relevance: 50, completeness: 50, creativity: 50 },
        B: { logic: 40, relevance: 40, completeness: 40, creativity: 40 },
      },
    },
    degraded: false,
  }),
}));

function createIoStub() {
  const room = {
    emit: vi.fn(),
    socketsLeave: vi.fn(),
    socketsJoin: vi.fn(),
  };

  return {
    to: vi.fn(() => room),
    in: vi.fn(() => room),
  };
}

describe('GameEngine chaining completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the final completed seat in CHAINING until host enters judging', async () => {
    const io = createIoStub();
    const engine = await GameEngine.create('room-1', null, io as any);

    engine.state.phase = 'CHAINING';
    engine.state.round = 1;
    engine.state.topic = '全部跳過測試';
    engine.state.rules.seats = 1;

    expect(await engine.skipTurn('A')).toBe(true);
    expect(engine.state.phase).toBe('CHAINING');
    expect(engine.state.teams.A.done).toBe(true);

    expect(await engine.skipTurn('B')).toBe(true);
    expect(engine.state.phase).toBe('CHAINING');
    expect(engine.state.teams.B.done).toBe(true);
    expect(canAdvanceSeatManually(engine.state)).toBe(true);

    expect(await engine.advanceSeat()).toBe(true);
    expect(engine.state.phase).toBe('ROUND_RESULT');
    expect(engine.state.rounds).toHaveLength(1);
  });
});
