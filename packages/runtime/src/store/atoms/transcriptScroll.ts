/**
 * Transcript Scroll State Atoms
 *
 * Per-session state tracking for auto-scroll behavior in the transcript.
 * Uses atomFamily keyed by sessionId so state persists across component
 * remounts and isn't affected by React render timing issues.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { store } from '../store';
import type { TranscriptReturnState } from '../../ui/AgentTranscript/utils/transcriptReturnTarget';

/**
 * Per-session flag tracking if user is at the bottom of the transcript.
 * Updated by onScroll handler, read by auto-scroll logic.
 * Defaults to true (new sessions start scrolled to bottom).
 */
export const sessionIsAtBottomAtom = atomFamily((_sessionId: string) =>
  atom<boolean>(true)
);

/**
 * Update the isAtBottom state for a session.
 * Call from onScroll handler.
 */
export function setSessionIsAtBottom(sessionId: string, isAtBottom: boolean): void {
  store.set(sessionIsAtBottomAtom(sessionId), isAtBottom);
}

/**
 * Get current isAtBottom state for a session.
 */
export function getSessionIsAtBottom(sessionId: string): boolean {
  return store.get(sessionIsAtBottomAtom(sessionId));
}

/**
 * Per-session position remembered when the transcript is left, used to pick
 * where it reopens. In memory only; undefined until the session was shown.
 */
export const sessionReturnStateAtom = atomFamily((_sessionId: string) =>
  atom<TranscriptReturnState | undefined>(undefined)
);

export function setSessionReturnState(sessionId: string, state: TranscriptReturnState): void {
  store.set(sessionReturnStateAtom(sessionId), state);
}

export function getSessionReturnState(sessionId: string): TranscriptReturnState | undefined {
  return store.get(sessionReturnStateAtom(sessionId));
}

/**
 * Cleanup atom for a session (call when session is deleted).
 */
export function cleanupSessionScrollState(sessionId: string): void {
  sessionIsAtBottomAtom.remove(sessionId);
  sessionReturnStateAtom.remove(sessionId);
}
