import type { StoredEntry } from './entry';

export const PRACTICE_LIMIT = 10;

export function eligiblePracticeEntries(
  entries: readonly Readonly<StoredEntry>[],
): Readonly<StoredEntry>[] {
  return entries.filter(entry => entry.translation.trim().length > 0);
}

export function samplePracticeEntries(
  entries: readonly Readonly<StoredEntry>[],
  random: () => number = Math.random,
): Readonly<StoredEntry>[] {
  const pool = eligiblePracticeEntries(entries);
  const count = Math.min(PRACTICE_LIMIT, pool.length);
  const selected: Readonly<StoredEntry>[] = [];
  // Partial Fisher–Yates: draw only the cards needed, from the eligible pool.
  for (let index = 0; index < count; index++) {
    const picked = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[picked]] = [pool[picked], pool[index]];
    selected.push({ ...pool[index], categoryIds: [...pool[index].categoryIds] });
  }
  return selected;
}

export type PracticeRating = 'recalled' | 'missed';
export type PracticeProgress = { revealed: boolean; rating: PracticeRating | null };
export type PracticeIdentity = { session: number; round: number; revision: number };
export type PracticeCardIdentity = PracticeIdentity & { entryId: number };

export type ActivePractice = PracticeIdentity & {
  phase: 'card' | 'summary';
  cards: readonly Readonly<StoredEntry>[];
  progress: readonly Readonly<PracticeProgress>[];
  index: number;
};

export type PracticeState = { phase: 'idle'; session: number } | ActivePractice;

export const initialPracticeState: PracticeState = { phase: 'idle', session: 0 };

export type PracticeAction =
  | { type: 'start'; cards: readonly Readonly<StoredEntry>[] }
  | { type: 'exit' }
  | ((
      | { type: 'reveal' }
      | { type: 'navigate'; direction: 'previous' | 'next' }
      | { type: 'rate'; rating: PracticeRating }
      | { type: 'view-results' }
    ) & PracticeCardIdentity)
  | ({ type: 'resume' } & PracticeIdentity)
  | ({ type: 'retry' } & PracticeIdentity);

export function practiceCounts(state: ActivePractice): { recalled: number; missed: number; unrated: number } {
  const counts = { recalled: 0, missed: 0, unrated: 0 };
  for (const { rating } of state.progress) {
    if (rating === null) counts.unrated++;
    else counts[rating]++;
  }
  return counts;
}

export function practiceReducer(state: PracticeState, action: PracticeAction): PracticeState {
  if (action.type === 'start') {
    if (state.phase !== 'idle') return state;
    const cards = eligiblePracticeEntries(action.cards)
      .slice(0, PRACTICE_LIMIT)
      .map(entry => ({ ...entry, categoryIds: [...entry.categoryIds] }));
    if (!cards.length) return state;
    return {
      phase: 'card', session: state.session + 1, round: 1, revision: 0, cards,
      progress: cards.map(() => ({ revealed: false, rating: null })), index: 0,
    };
  }
  if (action.type === 'exit') {
    return state.phase === 'idle' ? state : { phase: 'idle', session: state.session };
  }
  if (
    state.phase === 'idle'
    || action.session !== state.session
    || action.round !== state.round
    || action.revision !== state.revision
  ) return state;

  const revision = state.revision + 1;
  if (action.type === 'resume') {
    if (state.phase !== 'summary') return state;
    const unrated = state.progress.findIndex(value => value.rating === null);
    return { ...state, phase: 'card', revision, index: unrated < 0 ? state.index : unrated };
  }
  if (action.type === 'retry') {
    if (state.phase !== 'summary' || practiceCounts(state).unrated > 0) return state;
    const cards = state.cards.filter((_, index) => state.progress[index].rating === 'missed');
    if (!cards.length) return state;
    return {
      phase: 'card', session: state.session, round: state.round + 1, revision, cards,
      progress: cards.map(() => ({ revealed: false, rating: null })), index: 0,
    };
  }
  if (state.phase !== 'card' || action.entryId !== state.cards[state.index].id) return state;

  switch (action.type) {
    case 'navigate': {
      const index = state.index + (action.direction === 'next' ? 1 : -1);
      if (index < 0 || index >= state.cards.length) return state;
      return { ...state, index, revision };
    }
    case 'view-results':
      return { ...state, phase: 'summary', revision };
    case 'reveal':
      if (state.progress[state.index].revealed) return state;
      return {
        ...state, revision,
        progress: state.progress.map((value, index) => index === state.index ? { ...value, revealed: true } : value),
      };
    case 'rate': {
      if (!state.progress[state.index].revealed) return state;
      const next = state.index + 1;
      return {
        ...state, revision, phase: next === state.cards.length ? 'summary' : 'card',
        index: Math.min(next, state.cards.length - 1),
        progress: state.progress.map((value, index) => index === state.index ? { ...value, rating: action.rating } : value),
      };
    }
  }
}
