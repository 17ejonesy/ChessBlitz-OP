import { describe, expect, jest, test } from '@jest/globals';
jest.mock('@/api/SupabaseClient', () => ({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
}));
jest.mock('@/constants/urls', () => ({ getApiUrl: () => 'http://127.0.0.1:5000' }));

import {
    WRONG_MOVE_FALLBACK,
    WRONG_MOVE_MESSAGES,
    buildRequestBody,
    classifyWrongMove,
    getWrongMoveMessage,
    mockWrongMove,
    parseVerdict,
} from '@/api/WrongMove';

const req = { puzzleId: '00Kia', moveIndex: 1, fen: '5r1k/4n2p/1p4p1/pP5Q/P2pB2K/6P1/2P4P/4q3 w - - 0 38', move: 'h5g4' };

describe('wrong-move feedback', () => {
    test.each(['blunder', 'miss', 'also_works'] as const)('%s shows its message', async (v) => {
        const msg = await getWrongMoveMessage(req, { transport: async () => ({ classification: v }) });
        expect(msg).toBe(WRONG_MOVE_MESSAGES[v]);
    });

    test('the three messages are different and short', () => {
        const all = Object.values(WRONG_MOVE_MESSAGES);
        expect(new Set(all).size).toBe(3);
        all.forEach((m) => expect(m.split(' ').length).toBeLessThanOrEqual(12));
    });

    test('network error falls back', async () => {
        const msg = await getWrongMoveMessage(req, {
            transport: async () => {
                throw new TypeError('Network request failed');
            },
        });
        expect(msg).toBe(WRONG_MOVE_FALLBACK);
    });

    test('slow reply falls back after the timeout', async () => {
        const started = Date.now();
        const msg = await getWrongMoveMessage(req, {
            timeoutMs: 100,
            transport: () => new Promise((resolve) => setTimeout(() => resolve({ classification: 'miss' }), 2000)),
        });
        expect(msg).toBe(WRONG_MOVE_FALLBACK);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test.each([null, 'oops', {}, { classification: 'bad' }, { error: 'Something went wrong' }])(
        'unexpected body %p falls back',
        async (body) => {
            expect(await getWrongMoveMessage(req, { transport: async () => body })).toBe(WRONG_MOVE_FALLBACK);
        },
    );

    test('live mode with the backend off falls back (real fetch)', async () => {
        const realFetch = global.fetch;
        global.fetch = jest.fn(async () => {
            throw new TypeError('Network request failed');
        }) as unknown as typeof fetch;
        try {
            expect(await getWrongMoveMessage(req, { source: 'live' })).toBe(WRONG_MOVE_FALLBACK);
            expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:5000/wrong-move', expect.objectContaining({ method: 'POST' }));
        } finally {
            global.fetch = realFetch;
        }
    });

    test('live mode HTTP 500 falls back', async () => {
        const realFetch = global.fetch;
        global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) })) as unknown as typeof fetch;
        try {
            expect(await getWrongMoveMessage(req, { source: 'live' })).toBe(WRONG_MOVE_FALLBACK);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('mock is repeatable and produces every verdict', async () => {
        const moves = ['h5g4', 'h5h6', 'e4d5', 'h5f7', 'e4g6', 'h5e8', 'a4a5'];
        const seen = new Set<string | null>();
        for (const move of moves) {
            const a = parseVerdict(await mockWrongMove({ ...req, move }));
            const b = parseVerdict(await mockWrongMove({ ...req, move }));
            expect(a).toBe(b);
            seen.add(a);
        }
        expect(seen).toEqual(new Set(['blunder', 'miss', 'also_works']));
    });

    test('request body uses snake_case keys', () => {
        expect(buildRequestBody(req)).toEqual({ puzzle_id: '00Kia', move_index: 1, fen: req.fen, move: 'h5g4' });
    });

    test('classifyWrongMove never throws', async () => {
        await expect(classifyWrongMove(req, { transport: () => Promise.reject('boom') })).resolves.toBeNull();
    });
});
