import { getApiUrl } from '@/constants/urls';
import { supabase } from '@/api/SupabaseClient';
import { WRONG_MOVE_SOURCE, WRONG_MOVE_TIMEOUT_MS } from '@/constants/hints';

/**
 * Wrong-move feedback (Ticket 6), backed by Ticket 5's POST /wrong-move.
 *
 * Contract this file assumes (confirm with whoever has Ticket 5; if it differs, only
 * `buildRequestBody` and `parseVerdict` need to change):
 *
 *   POST /wrong-move
 *   { "puzzle_id": "00Kia", "move_index": 1, "fen": "<position before the move>", "move": "h5g4" }
 *   -> 200 { "classification": "blunder" | "miss" | "also_works", ...anything else }
 */

export type WrongMoveVerdict = 'blunder' | 'miss' | 'also_works';

export type WrongMoveRequest = {
    puzzleId: string;
    /** Which player move, starting at 1. */
    moveIndex: number;
    /** FEN of the position the player moved from. */
    fen: string;
    /** The move the player made, in UCI (e.g. "e2e4", "a7a8q"). */
    move: string;
};

export const WRONG_MOVE_FALLBACK = 'Not quite, try again';

export const WRONG_MOVE_MESSAGES: Record<WrongMoveVerdict, string> = {
    blunder: 'Oops! That move gives something away. Try again!',
    miss: "Not bad, but there's a better move here. Try again!",
    also_works: 'That works too! Can you find the move the puzzle wants?',
};

const VERDICTS: WrongMoveVerdict[] = ['blunder', 'miss', 'also_works'];

export function buildRequestBody(req: WrongMoveRequest) {
    return { puzzle_id: req.puzzleId, move_index: req.moveIndex, fen: req.fen, move: req.move };
}

/** Pull the verdict out of a /wrong-move response. Anything unexpected gives `null`. */
export function parseVerdict(body: unknown): WrongMoveVerdict | null {
    if (!body || typeof body !== 'object') {
        return null;
    }
    const value = (body as Record<string, unknown>).classification;
    return VERDICTS.includes(value as WrongMoveVerdict) ? (value as WrongMoveVerdict) : null;
}

/**
 * Stand-in for Ticket 5 while it's being built. Picks a verdict from the move's letters, so the
 * same wrong move always gets the same message and different moves show all three.
 */
export async function mockWrongMove(req: WrongMoveRequest): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    let sum = 0;
    for (const ch of req.move) sum += ch.charCodeAt(0);
    return { classification: VERDICTS[sum % VERDICTS.length], mock: true };
}

async function liveWrongMove(req: WrongMoveRequest, signal: AbortSignal): Promise<unknown> {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`${getApiUrl()}/wrong-move`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal,
    });
    if (!response.ok) {
        throw new Error(`wrong-move HTTP ${response.status}`);
    }
    return response.json();
}

type Options = {
    source?: 'mock' | 'live';
    timeoutMs?: number;
    /** Swap the transport in tests. */
    transport?: (req: WrongMoveRequest, signal: AbortSignal) => Promise<unknown>;
};

/** The verdict for a wrong move, or `null` if the call failed, was too slow, or made no sense. */
export async function classifyWrongMove(req: WrongMoveRequest, options: Options = {}): Promise<WrongMoveVerdict | null> {
    const source = options.source ?? WRONG_MOVE_SOURCE;
    const timeoutMs = options.timeoutMs ?? WRONG_MOVE_TIMEOUT_MS;
    const transport = options.transport ?? (source === 'mock' ? (r: WrongMoveRequest) => mockWrongMove(r) : liveWrongMove);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, timeoutMs);
    });

    try {
        const body = await Promise.race([transport(req, controller.signal), timeout]);
        return parseVerdict(body);
    } catch (err) {
        console.warn('wrong-move lookup failed:', err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** The message to show the player. Never throws and never returns a raw error. */
export async function getWrongMoveMessage(req: WrongMoveRequest, options: Options = {}): Promise<string> {
    const verdict = await classifyWrongMove(req, options);
    return verdict ? WRONG_MOVE_MESSAGES[verdict] : WRONG_MOVE_FALLBACK;
}
