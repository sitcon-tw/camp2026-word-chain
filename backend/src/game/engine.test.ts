import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameEngine } from './engine.js';
vi.mock('../state/roomRepo.js', () => ({
  saveRoom: vi.fn().mockResolvedValue(undefined),
  loadPlayers: vi.fn().mockResolvedValue([]),
  savePlayer: vi.fn().mockResolvedValue(undefined),
  deletePlayer: vi.fn().mockResolvedValue(undefined),
  clearEvents: vi.fn().mockResolvedValue(undefined),
  pushEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ai/openai.js', () => ({
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
    sockets: { sockets: new Map() },
  };
}

describe('GameEngine chaining completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-enters judging after the final paired seat completes', async () => {
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
    expect(engine.state.phase).toBe('ROUND_RESULT');
    expect(engine.state.rounds).toHaveLength(1);
  });

  it('auto-advances to the next seat once both teams submit the current seat', async () => {
    const io = createIoStub();
    const engine = await GameEngine.create('room-3', null, io as any);

    engine.state.phase = 'CHAINING';
    engine.state.round = 1;
    engine.state.topic = '自動換棒';
    engine.state.rules.seats = 2;

    await engine.addPlayer({
      playerId: 'a',
      team: 'A',
      groupNumber: 1,
      name: 'A',
      connected: true,
      lastSeen: Date.now(),
      socketId: 'socket-a',
    });
    await engine.addPlayer({
      playerId: 'b',
      team: 'B',
      groupNumber: 2,
      name: 'B',
      connected: true,
      lastSeen: Date.now(),
      socketId: 'socket-b',
    });

    expect(await engine.submit('a', '一二三四五')).toEqual({ ok: true });
    expect(engine.state.teams.A.currentSeat).toBe(2);
    expect(engine.state.teams.B.currentSeat).toBe(1);

    expect(await engine.submit('b', '甲乙丙丁戊')).toEqual({ ok: true });
    expect(engine.state.teams.A.currentSeat).toBe(2);
    expect(engine.state.teams.B.currentSeat).toBe(2);
    expect(engine.state.phase).toBe('CHAINING');
  });

  it('auto-starts the next round after round-result countdown ends', async () => {
    vi.useFakeTimers();
    try {
      const io = createIoStub();
      const engine = await GameEngine.create('room-4', null, io as any);

      engine.state.phase = 'CHAINING';
      engine.state.round = 1;
      engine.state.topic = '結果倒數';
      engine.state.rules.seats = 1;
      engine.state.rules.resultMs = 1_000;
      engine.state.matchups = [
        { groupA: 1, groupB: 2 },
        { groupA: 3, groupB: 4 },
      ];
      engine.state.matchupCursor = 0;
      engine.state.activeMatchup = { groupA: 1, groupB: 2 };

      expect(await engine.skipTurn('A')).toBe(true);
      expect(await engine.skipTurn('B')).toBe(true);
      expect(engine.state.phase).toBe('ROUND_RESULT');
      expect(engine.state.phaseEndsAt).not.toBeNull();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(engine.state.phase).toBe('ROUND_INTRO');
      expect(engine.state.round).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the finished matchup players instead of moving them back to waiting on endGame', async () => {
    const io = createIoStub();
    const engine = await GameEngine.create('room-2', null, io as any);

    await engine.addPlayer({
      playerId: 'p-a',
      team: 'A',
      groupNumber: 2,
      name: '第 2 組',
      connected: true,
      lastSeen: Date.now(),
      socketId: 'socket-a',
    });
    await engine.addPlayer({
      playerId: 'p-b',
      team: 'B',
      groupNumber: 7,
      name: '第 7 組',
      connected: true,
      lastSeen: Date.now(),
      socketId: 'socket-b',
    });
    await engine.addPlayer({
      playerId: 'p-wait',
      team: null,
      groupNumber: null,
      name: '等待中',
      connected: true,
      lastSeen: Date.now(),
      socketId: 'socket-w',
    });

    engine.state.phase = 'MATCH_OVER';
    engine.state.activeMatchup = { groupA: 2, groupB: 7 };

    expect(await engine.endGame()).toBe(true);
    expect(engine.players.has('p-a')).toBe(false);
    expect(engine.players.has('p-b')).toBe(false);
    expect(engine.players.has('p-wait')).toBe(true);
  });
});
