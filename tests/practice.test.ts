import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackup, serializeBackup } from '../src/backup';
import type { StoredEntry } from '../src/entry';
import { paginateLibraryEntries, selectLibraryEntries } from '../src/library';
import {
  PRACTICE_LIMIT, eligiblePracticeEntries, initialPracticeState, practiceCounts, practiceReducer, samplePracticeEntries,
  type ActivePractice, type PracticeAction, type PracticeState,
} from '../src/practice';
import { createTestDatabase, createTestStore, dumpTables } from './helpers/database';

const created = '2024-02-29T12:34:56.789Z';
const exportedAt = '2026-09-28T08:00:00.000Z';

function entry(id: number, overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    word: 'word ' + String.fromCharCode(96 + id),
    phonetic: 'US /test/ · UK /test/',
    translation: `合成译文 ${id}`,
    pos: 'Noun',
    definition: `Synthetic definition ${id}.`,
    example: `Synthetic example ${id}.`,
    source: `Synthetic historical attribution ${id} | opaque source text`,
    created, id, categoryIds: [], ...overrides,
  };
}

const pool = (size: number) => Array.from({ length: size }, (_, index) => entry(index + 1));
const ids = (entries: readonly Readonly<StoredEntry>[]) => entries.map(value => value.id);
const freshProgress = (size: number) => Array.from({ length: size }, () => ({ revealed: false, rating: null }));
const missedIds = (state: ActivePractice) => ids(state.cards.filter((_, index) => state.progress[index].rating === 'missed'));

function active(state: PracticeState) {
  assert.ok(state.phase !== 'idle');
  return state;
}

function roundIdentity(state: PracticeState) {
  assert.ok(state.phase !== 'idle');
  return { session: state.session, round: state.round, revision: state.revision };
}

function identity(state: PracticeState) {
  assert.ok(state.phase === 'card');
  return { ...roundIdentity(state), entryId: state.cards[state.index].id };
}

function start(cards: readonly Readonly<StoredEntry>[] = pool(3)) {
  const state = practiceReducer(initialPracticeState, { type: 'start', cards });
  assert.ok(state.phase === 'card');
  return state;
}

function reveal(state: PracticeState) {
  return active(practiceReducer(state, { type: 'reveal', ...identity(state) }));
}

function navigate(state: PracticeState, direction: 'previous' | 'next') {
  const next = practiceReducer(state, { type: 'navigate', ...identity(state), direction });
  assert.ok(next.phase === 'card');
  return next;
}

function results(state: PracticeState) {
  const summary = practiceReducer(state, { type: 'view-results', ...identity(state) });
  assert.ok(summary.phase === 'summary');
  return summary;
}

function resume(state: PracticeState) {
  const resumed = practiceReducer(state, { type: 'resume', ...roundIdentity(state) });
  assert.ok(resumed.phase === 'card');
  return resumed;
}

function retry(state: PracticeState) {
  const retried = practiceReducer(state, { type: 'retry', ...roundIdentity(state) });
  assert.ok(retried.phase === 'card');
  return retried;
}

function answer(state: PracticeState, recalled: boolean) {
  assert.ok(state.phase === 'card');
  const revealed = state.progress[state.index].revealed ? state : reveal(state);
  return active(practiceReducer(revealed, {
    type: 'rate', ...identity(revealed), rating: recalled ? 'recalled' : 'missed',
  }));
}

function finish(state: PracticeState, recalled: readonly boolean[]) {
  for (const result of recalled) state = answer(state, result);
  assert.ok(state.phase === 'summary');
  return state;
}

function freezeState<T extends PracticeState>(state: T): Readonly<T> {
  if (state.phase !== 'idle') {
    state.cards.forEach(value => { Object.freeze(value.categoryIds); Object.freeze(value); });
    state.progress.forEach(value => Object.freeze(value));
    Object.freeze(state.cards);
    Object.freeze(state.progress);
  }
  return Object.freeze(state);
}

function cardActions(state: ActivePractice): Extract<PracticeAction, { entryId: number }>[] {
  return [
    { type: 'reveal', ...identity(state) },
    { type: 'rate', ...identity(state), rating: 'missed' },
    { type: 'navigate', ...identity(state), direction: 'next' },
    { type: 'view-results', ...identity(state) },
  ];
}

test('eligibility excludes only blank translations, preserving content and order across scripts', () => {
  const translations = [
    '', ' \t\r\n', '  　﻿',
    'English only', '中文', 'é', 'é', 'العربية', '日本語', '\u{20000}', '​', '0', '#?!',
    ' \tmeaning\n ',
  ];
  const values = Object.freeze(translations.map((translation, index) => Object.freeze(entry(index + 1, { translation }))));
  const before = structuredClone(values);
  const eligible = eligiblePracticeEntries(values);
  assert.deepEqual(eligible, values.slice(3));
  assert.notEqual(eligible, values);
  for (let index = 0; index < eligible.length; index++) assert.equal(eligible[index], values[index + 3]);
  assert.deepEqual(values, before);
  assert.deepEqual(eligiblePracticeEntries([]), []);
  assert.deepEqual(eligiblePracticeEntries(values.slice(0, 3)), []);
  assert.equal(eligiblePracticeEntries([entry(1, {
    word: '[imported]', translation: 'answer', phonetic: '', pos: '', definition: '', example: '', source: '',
  })]).length, 1);
});

for (const size of [0, 1, 9, 10, 11, 25]) {
  test(`sampling a ${size}-entry eligible pool selects at most ten without replacement or mutation`, () => {
    assert.equal(PRACTICE_LIMIT, 10);
    const values = Object.freeze(pool(size).map(value => Object.freeze(value)));
    const before = structuredClone(values);
    let calls = 0;
    const selected = samplePracticeEntries(values, () => { calls++; return 0; });
    const count = Math.min(size, 10);
    assert.equal(selected.length, count);
    assert.equal(calls, count);
    assert.deepEqual(ids(selected), Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(new Set(ids(selected)).size, count);
    assert.notEqual(selected, values);
    selected.forEach((value, index) => {
      assert.deepEqual(value, values[index]);
      assert.notEqual(value, values[index]);
    });
    assert.deepEqual(values, before);
  });
}

test('sampling filters before drawing or applying its limit, even with many leading blank answers', () => {
  const blank = Array.from({ length: 15 }, (_, index) => entry(index + 30, { translation: index % 2 ? '' : ' \t　' }));
  const values = [...blank, ...pool(11)];
  let calls = 0;
  const selected = samplePracticeEntries(values, () => { calls++; return 0; });
  assert.deepEqual(ids(selected), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(calls, 10);
  assert.deepEqual(samplePracticeEntries(blank, () => { throw new Error('No draw is needed'); }), []);
  assert.deepEqual(ids(samplePracticeEntries([blank[0], entry(1), blank[1], entry(2)], () => 0)), [1, 2]);
});

test('partial Fisher–Yates uses injected draws deterministically and can reach the last eligible entry', () => {
  const draws = [0.9, 0, 0.5, 0.25, 0.75, 0.1, 0.99, 0.4, 0.6, 0.2];
  const values = pool(12);
  for (let attempt = 0; attempt < 2; attempt++) {
    let index = 0;
    const selected = samplePracticeEntries(values, () => {
      assert.ok(index < draws.length, 'Do not shuffle the unused remainder');
      return draws[index++];
    });
    assert.deepEqual(ids(selected), [11, 2, 8, 6, 1, 4, 12, 10, 5, 3]);
    assert.equal(index, 10);
  }
  assert.deepEqual(ids(samplePracticeEntries(values, () => 1 - Number.EPSILON)), [12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(values, pool(12));
});

test('sampling defaults to Math.random and copies every field including nested category IDs', t => {
  const random = t.mock.method(Math, 'random', () => 0);
  const values = [entry(1, { categoryIds: [2, 7] }), entry(2)];
  values[0].translation = ' \nKeep this complete answer\t ';
  const before = structuredClone(values);
  const selected = samplePracticeEntries(values);
  assert.deepEqual(selected, before);
  selected.forEach((value, index) => assert.notEqual(value.categoryIds, values[index].categoryIds));
  assert.equal(random.mock.callCount(), 2);
  values[0].categoryIds.splice(0, 2, 9);
  values[1].categoryIds.push(4);
  assert.deepEqual(selected, before);
  Object.assign(values[0], entry(20, { word: 'replacement', created: exportedAt }));
  values.reverse();
  values.length = 0;
  assert.deepEqual(selected, before);
});

test('sampling and reducer starts isolate category arrays between inputs, cards and separate sessions', () => {
  const sharedCategoryIds = [2, 7];
  const values = [entry(1, { categoryIds: sharedCategoryIds }), entry(2, { categoryIds: sharedCategoryIds })];
  const sampled = samplePracticeEntries(values, () => 0);
  assert.notEqual(sampled[0].categoryIds, sharedCategoryIds);
  assert.notEqual(sampled[1].categoryIds, sharedCategoryIds);
  assert.notEqual(sampled[0].categoryIds, sampled[1].categoryIds);
  const question = start(sampled);
  const other = start(sampled);
  for (const [index, card] of question.cards.entries()) {
    assert.notEqual(card.categoryIds, sampled[index].categoryIds);
    assert.notEqual(card.categoryIds, other.cards[index].categoryIds);
    assert.deepEqual(card.categoryIds, [2, 7]);
  }
  question.cards[0].categoryIds.push(9);
  assert.deepEqual(question.cards[1].categoryIds, [2, 7]);
  assert.deepEqual(other.cards.map(card => card.categoryIds), [[2, 7], [2, 7]]);
  assert.deepEqual(sampled.map(card => card.categoryIds), [[2, 7], [2, 7]]);
  assert.deepEqual(sharedCategoryIds, [2, 7]);
});

for (const category of ['uncategorized', 7] as const) {
  test(`practice uses all category ${category} and search matches beyond the displayed page`, () => {
    const categoryIds = category === 'uncategorized' ? [] : [category, 9];
    const values = [
      entry(100, { word: 'shared excluded', categoryIds: [9] }),
      entry(101, { word: 'translation match excluded', translation: 'SHARED answer', categoryIds: [9] }),
      entry(102, { word: 'no matching text', categoryIds: [...categoryIds] }),
      ...Array.from({ length: 41 }, (_, index) => entry(index + 1, {
        word: `shared ${String(index + 1).padStart(2, '0')}`,
        translation: index < 20 ? ' \t　' : `answer ${index + 1}`,
        categoryIds: [...categoryIds],
      })),
    ];
    const before = structuredClone(values);
    for (const sort of ['recent', 'alphabetical'] as const) {
      const fullResult = selectLibraryEntries(values, ' SHARED ', sort, category);
      const displayed = paginateLibraryEntries(fullResult, 1);
      const eligible = eligiblePracticeEntries(fullResult);
      assert.equal(fullResult.length, 41);
      assert.equal(displayed.entries.length, 20);
      assert.equal(eligible.length, 21);
      assert.equal(eligiblePracticeEntries(displayed.entries).length, sort === 'recent' ? 20 : 0);
      const sampled = samplePracticeEntries(fullResult, () => 1 - Number.EPSILON);
      assert.equal(sampled.length, PRACTICE_LIMIT);
      assert.equal(sampled[0].id, sort === 'recent' ? 21 : 41);
      assert.ok(!displayed.entries.some(value => value.id === sampled[0].id));
      assert.ok(sampled.every(value => eligible.some(candidate => candidate.id === value.id)));
      const question = start(sampled);
      assert.deepEqual(question.cards, sampled);
      for (const [index, card] of question.cards.entries()) assert.notEqual(card.categoryIds, sampled[index].categoryIds);
      assert.deepEqual(values, before);
    }
  });
}

test('practice uses the full filtered result, including eligible entries outside the displayed library page', () => {
  const values = Object.freeze([
    entry(100, { word: 'outside the filter' }),
    ...Array.from({ length: 41 }, (_, index) => entry(index + 1, {
      word: `shared ${String(index + 1).padStart(2, '0')}`,
      translation: index < 20 ? ' \t　' : `answer ${index + 1}`,
    })),
  ].map(value => Object.freeze(value)));
  const before = structuredClone(values);
  for (const sort of ['recent', 'alphabetical'] as const) {
    const fullResult = selectLibraryEntries(values, ' SHARED ', sort);
    const displayed = paginateLibraryEntries(fullResult, 1);
    const eligible = eligiblePracticeEntries(fullResult);
    assert.equal(fullResult.length, 41);
    assert.equal(displayed.entries.length, 20);
    assert.deepEqual(ids(eligible), Array.from({ length: 21 }, (_, index) => sort === 'recent' ? 41 - index : index + 21));
    assert.equal(eligiblePracticeEntries(displayed.entries).length, sort === 'recent' ? 20 : 0);

    const sampled = samplePracticeEntries(fullResult, () => 1 - Number.EPSILON);
    assert.equal(sampled.length, PRACTICE_LIMIT);
    assert.equal(sampled[0].id, sort === 'recent' ? 21 : 41);
    assert.ok(!displayed.entries.some(value => value.id === sampled[0].id));
    assert.ok(sampled.every(value => eligible.some(candidate => candidate.id === value.id)));
    assert.deepEqual(start(sampled).cards, sampled);
    assert.deepEqual(values, before);
  }
});

test('start requires idle and eligible cards, keeps sampled order, caps the round, and never draws randomness', t => {
  t.mock.method(Math, 'random', () => { throw new Error('The reducer must not draw randomness'); });
  assert.deepEqual(initialPracticeState, { phase: 'idle', session: 0 });
  const idle = freezeState(initialPracticeState);
  for (const cards of [[], [entry(1, { translation: '' })], [entry(2, { translation: '\t　' })]])
    assert.equal(practiceReducer(idle, { type: 'start', cards }), idle);
  const cards = Object.freeze([entry(90, { translation: '' }), ...pool(11).reverse()].map(value => Object.freeze(value)));
  const action = Object.freeze({ type: 'start' as const, cards });
  const state = practiceReducer(idle, action);
  assert.deepEqual(state, {
    phase: 'card', session: 1, round: 1, revision: 0, index: 0,
    cards: cards.slice(1, 11), progress: freshProgress(10),
  });
  assert.ok(state.phase === 'card');
  assert.notEqual(state.cards, cards);
  state.cards.forEach((value, index) => assert.notEqual(value, cards[index + 1]));
  assert.equal(new Set(state.progress).size, 10, 'Progress slots are independent objects');
  for (const current of [state, reveal(state), results(state), finish(start(pool(1)), [false])])
    assert.equal(practiceReducer(current, action), current);
  assert.deepEqual(idle, { phase: 'idle', session: 0 });
});

test('counts distinguish unrated from recalled and missed without exposing mutable state', () => {
  const state = freezeState(start());
  const counts = practiceCounts(state);
  assert.deepEqual(counts, { recalled: 0, missed: 0, unrated: 3 });
  counts.unrated = 0;
  assert.deepEqual(practiceCounts(state), { recalled: 0, missed: 0, unrated: 3 });
  assert.deepEqual(practiceCounts(answer(state, false)), { recalled: 0, missed: 1, unrated: 2 });
  assert.deepEqual(practiceCounts(answer(state, true)), { recalled: 1, missed: 0, unrated: 2 });
});

test('idle and wrong session, round, revision or entry identities cannot act on cards', () => {
  const question = freezeState(start());
  const revealed = freezeState(reveal(question));
  for (const state of [question, revealed]) {
    const actions: PracticeAction[] = cardActions(state);
    actions.push({ type: 'resume', ...roundIdentity(state) }, { type: 'retry', ...roundIdentity(state) });
    for (const action of actions) assert.equal(practiceReducer(initialPracticeState, action), initialPracticeState);
    for (const action of cardActions(state)) {
      for (const changed of [
        { session: 0 }, { session: 2 }, { round: 0 }, { round: 2 },
        { revision: state.revision - 1 }, { revision: state.revision + 1 }, { entryId: 2 }, { entryId: 99 },
      ]) assert.equal(practiceReducer(state, { ...action, ...changed }), state);
    }
    assert.equal(practiceReducer(state, { type: 'resume', ...roundIdentity(state) }), state);
    assert.equal(practiceReducer(state, { type: 'retry', ...roundIdentity(state) }), state);
  }
});

test('reveal is immutable and gates grading, including stale actions captured before reveal', () => {
  const question = freezeState(start());
  const before = structuredClone(question);
  const oldActions = cardActions(question);
  const rate: PracticeAction = { type: 'rate', ...identity(question), rating: 'missed' };
  assert.equal(practiceReducer(question, rate), question);
  const revealed = freezeState(reveal(question));
  assert.deepEqual(revealed, {
    ...question, revision: 1,
    progress: [{ revealed: true, rating: null }, ...freshProgress(2)],
  });
  assert.equal(practiceReducer(revealed, { type: 'reveal', ...identity(revealed) }), revealed);
  for (const action of oldActions) assert.equal(practiceReducer(revealed, action), revealed);
  assert.deepEqual(question, before);
  assert.equal(revealed.cards, question.cards);
  assert.notEqual(revealed.progress, question.progress);
  assert.equal(revealed.progress[1], question.progress[1]);
  const next = answer(revealed, false);
  assert.equal(next.index, 1);
  assert.deepEqual(next.progress, [{ revealed: true, rating: 'missed' }, ...freshProgress(2)]);
  assert.deepEqual(practiceCounts(next), { recalled: 0, missed: 1, unrated: 2 });
});

test('navigation is bounded, never grades or reveals, and preserves existing reveal state', () => {
  const question = freezeState(start());
  assert.equal(navigate(question, 'previous'), question);
  const nextAction: PracticeAction = { type: 'navigate', ...identity(question), direction: 'next' };
  const second = freezeState(active(practiceReducer(question, nextAction)));
  assert.equal(second.index, 1);
  assert.equal(second.revision, 1);
  assert.equal(second.progress, question.progress);
  assert.equal(second.cards, question.cards);
  assert.equal(practiceReducer(second, nextAction), second);
  const third = freezeState(navigate(second, 'next'));
  assert.equal(third.index, 2);
  assert.equal(navigate(third, 'next'), third);
  assert.deepEqual(practiceCounts(third), { recalled: 0, missed: 0, unrated: 3 });
  const revealed = freezeState(reveal(third));
  const revisited = navigate(navigate(revealed, 'previous'), 'next');
  assert.equal(revisited.index, 2);
  assert.equal(revisited.progress, revealed.progress);
  assert.deepEqual(revisited.progress[2], { revealed: true, rating: null });
  assert.deepEqual(practiceCounts(revisited), { recalled: 0, missed: 0, unrated: 3 });
  assert.deepEqual(question.progress, freshProgress(3));
});

test('single-card rounds cannot navigate, can show partial results, and retain editable final ratings', () => {
  const question = freezeState(start(pool(1)));
  for (const direction of ['previous', 'next'] as const) assert.equal(navigate(question, direction), question);
  const partial = results(question);
  assert.deepEqual(practiceCounts(partial), { recalled: 0, missed: 0, unrated: 1 });
  assert.equal(partial.index, 0);
  const complete = answer(resume(partial), true);
  assert.equal(complete.phase, 'summary');
  assert.equal(complete.index, 0);
  const review = resume(complete);
  assert.deepEqual(review.progress[0], { revealed: true, rating: 'recalled' });
  for (const direction of ['previous', 'next'] as const) assert.equal(navigate(review, direction), review);
  const corrected = answer(review, false);
  assert.deepEqual(practiceCounts(corrected), { recalled: 0, missed: 1, unrated: 0 });
  assert.deepEqual(retry(corrected).progress, freshProgress(1));
});

test('old same-card actions and in-flight gesture identities stay stale after A to B to A', () => {
  for (const question of [start(), reveal(start())]) {
    const state = freezeState(question);
    const oldActions = cardActions(state);
    const returned = freezeState(navigate(navigate(state, 'next'), 'previous'));
    assert.equal(returned.session, state.session);
    assert.equal(returned.round, state.round);
    assert.equal(returned.index, state.index);
    assert.equal(returned.cards[returned.index].id, state.cards[state.index].id);
    assert.equal(returned.progress, state.progress);
    assert.equal(returned.revision, state.revision + 2);
    for (const action of oldActions) assert.equal(practiceReducer(returned, action), returned);
    assert.notEqual(practiceReducer(returned, { type: 'view-results', ...identity(returned) }), returned);
  }
});

test('grading advances once, preserves previously revealed next cards, and rejects duplicate submissions', () => {
  const secondRevealed = reveal(navigate(start(), 'next'));
  const firstRevealed = freezeState(reveal(navigate(secondRevealed, 'previous')));
  const action: PracticeAction = { type: 'rate', ...identity(firstRevealed), rating: 'recalled' };
  const next = freezeState(active(practiceReducer(firstRevealed, action)));
  assert.equal(next.phase, 'card');
  assert.equal(next.index, 1);
  assert.deepEqual(next.progress[1], { revealed: true, rating: null });
  for (const repeated of [action, { ...action, rating: 'missed' as const }])
    assert.equal(practiceReducer(next, repeated), next);
  assert.deepEqual(practiceCounts(next), { recalled: 1, missed: 0, unrated: 2 });
  const third = answer(next, false);
  assert.equal(third.index, 2);
  assert.deepEqual(third.progress[2], { revealed: false, rating: null });
  assert.deepEqual(practiceCounts(third), { recalled: 1, missed: 1, unrated: 1 });
});

for (const outcomes of [[false, false, false], [true, false, true], [true, true, true]]) {
  test(`round completion fixes the denominator and derives per-word results for ${outcomes.join('/')}`, () => {
    const question = freezeState(start());
    let state: ActivePractice = question;
    for (const [index, recalled] of outcomes.entries()) {
      const before = structuredClone(state);
      const previous = freezeState(state);
      state = answer(previous, recalled);
      assert.deepEqual(previous, before);
      assert.equal(state.cards, question.cards);
      assert.equal(state.cards.length, 3);
      assert.equal(state.revision, (index + 1) * 2);
      assert.deepEqual(missedIds(state), outcomes.slice(0, index + 1).flatMap((result, offset) => result ? [] : [offset + 1]));
      assert.deepEqual(practiceCounts(state), {
        recalled: outcomes.slice(0, index + 1).filter(Boolean).length,
        missed: outcomes.slice(0, index + 1).filter(value => !value).length,
        unrated: 2 - index,
      });
      assert.equal(state.phase, index === 2 ? 'summary' : 'card');
    }
    assert.equal(state.index, 2);
    assert.equal(state.session, 1);
    assert.equal(state.round, 1);
    const retried = practiceReducer(state, { type: 'retry', ...roundIdentity(state) });
    if (outcomes.every(Boolean)) assert.equal(retried, state);
    else assert.deepEqual(retried, {
      phase: 'card', session: 1, round: 2, revision: state.revision + 1, index: 0,
      cards: state.cards.filter((_, index) => !outcomes[index]),
      progress: freshProgress(outcomes.filter(value => !value).length),
    });
  });
}

test('editing a rating in either direction or repeating it replaces one result and still advances', () => {
  const question = freezeState(start());
  let state = answer(question, false);
  for (const recalled of [true, false, true, true]) {
    const review = freezeState(navigate(state, 'previous'));
    const before = structuredClone(review);
    const action: PracticeAction = { type: 'rate', ...identity(review), rating: recalled ? 'recalled' : 'missed' };
    state = active(practiceReducer(review, action));
    assert.equal(state.index, 1);
    assert.equal(state.revision, review.revision + 1);
    assert.deepEqual(practiceCounts(state), { recalled: Number(recalled), missed: Number(!recalled), unrated: 2 });
    assert.deepEqual(missedIds(state), recalled ? [] : [1]);
    assert.deepEqual(state.progress[0], { revealed: true, rating: recalled ? 'recalled' : 'missed' });
    assert.equal(practiceReducer(state, action), state);
    assert.deepEqual(review, before);
    assert.equal(state.progress[1], review.progress[1]);
    assert.equal(state.cards, question.cards);
  }
  assert.deepEqual(practiceCounts(question), { recalled: 0, missed: 0, unrated: 3 });
});

test('viewing partial or entirely unrated results never assigns ratings and cannot start a retry', () => {
  const question = start();
  const cases = [question, navigate(question, 'next'), answer(question, true), answer(question, false)];
  for (const state of cases) {
    const frozen = freezeState(state);
    const summary = freezeState(results(frozen));
    assert.equal(summary.index, frozen.index);
    assert.equal(summary.cards, frozen.cards);
    assert.equal(summary.progress, frozen.progress);
    assert.equal(summary.revision, frozen.revision + 1);
    assert.deepEqual(practiceCounts(summary), practiceCounts(frozen));
    assert.equal(practiceReducer(summary, { type: 'retry', ...roundIdentity(summary) }), summary);
    const continued = resume(summary);
    assert.equal(continued.index, frozen.progress.findIndex(value => value.rating === null));
    assert.equal(continued.progress, frozen.progress);
    assert.equal(continued.round, frozen.round);
    assert.equal(continued.revision, summary.revision + 1);
  }
});

test('grading the last word opens partial results and continuing finds the earliest skipped word', () => {
  const second = navigate(start(), 'next');
  const third = navigate(second, 'next');
  const partial = freezeState(answer(third, true));
  assert.equal(partial.phase, 'summary');
  assert.equal(partial.index, 2);
  assert.deepEqual(practiceCounts(partial), { recalled: 1, missed: 0, unrated: 2 });
  assert.equal(practiceReducer(partial, { type: 'retry', ...roundIdentity(partial) }), partial);
  const first = resume(partial);
  assert.equal(first.index, 0);
  assert.deepEqual(first.progress, [...freshProgress(2), { revealed: true, rating: 'recalled' }]);
  const afterFirst = answer(first, false);
  const continued = resume(results(afterFirst));
  assert.equal(continued.index, 1);
  const last = answer(continued, true);
  assert.equal(last.index, 2);
  assert.deepEqual(last.progress[2], { revealed: true, rating: 'recalled' });
  assert.deepEqual(practiceCounts(results(last)), { recalled: 2, missed: 1, unrated: 0 });
});

test('fully rated results resume the last viewed index and permit correction of the final word', () => {
  const complete = freezeState(finish(start(), [true, false, true]));
  const review = resume(complete);
  assert.equal(review.index, 2);
  assert.equal(review.progress, complete.progress);
  const corrected = answer(review, false);
  assert.equal(corrected.phase, 'summary');
  assert.deepEqual(practiceCounts(corrected), { recalled: 1, missed: 2, unrated: 0 });
  const earlier = navigate(navigate(resume(corrected), 'previous'), 'previous');
  const earlierSummary = results(earlier);
  assert.equal(earlierSummary.index, 0);
  const earlierReview = resume(earlierSummary);
  assert.equal(earlierReview.index, 0);
  assert.equal(earlierReview.progress, corrected.progress);
  assert.deepEqual(practiceCounts(complete), { recalled: 2, missed: 1, unrated: 0 });
});

test('summary actions require fresh identity, card actions cannot run there, and summary round-trips stale old actions', () => {
  const question = freezeState(start(pool(1)));
  const oldCardActions = cardActions(question);
  const partial = freezeState(results(question));
  const resumeAction: PracticeAction = { type: 'resume', ...roundIdentity(partial) };
  for (const type of ['resume', 'retry'] as const) {
    for (const changed of [{ session: 0 }, { session: 2 }, { round: 0 }, { round: 2 }, { revision: 0 }, { revision: 2 }])
      assert.equal(practiceReducer(partial, { type, ...roundIdentity(partial), ...changed }), partial);
  }
  for (const action of oldCardActions)
    assert.equal(practiceReducer(partial, { ...action, ...roundIdentity(partial) }), partial);
  const returned = freezeState(active(practiceReducer(partial, resumeAction)));
  for (const action of oldCardActions) assert.equal(practiceReducer(returned, action), returned);
  assert.equal(practiceReducer(returned, resumeAction), returned);
  const secondPartial = freezeState(results(returned));
  assert.equal(secondPartial.session, partial.session);
  assert.equal(secondPartial.round, partial.round);
  assert.equal(secondPartial.index, partial.index);
  assert.equal(practiceReducer(secondPartial, resumeAction), secondPartial);
  assert.notEqual(practiceReducer(secondPartial, { type: 'resume', ...roundIdentity(secondPartial) }), secondPartial);
});

test('retry uses the latest ratings in original card order, resets progress, and rejects earlier rounds', () => {
  const cards = [entry(8), entry(2), entry(9), entry(4)];
  let state = navigate(navigate(start(cards), 'next'), 'next');
  state = finish(state, [false, false]);
  assert.deepEqual(practiceCounts(state), { recalled: 0, missed: 2, unrated: 2 });
  assert.equal(practiceReducer(state, { type: 'retry', ...roundIdentity(state) }), state);
  state = answer(resume(state), false);
  state = answer(state, true);
  assert.equal(state.index, 2);
  state = answer(state, true);
  const complete = freezeState(answer(state, false));
  assert.deepEqual(missedIds(complete), [8, 4]);
  assert.deepEqual(practiceCounts(complete), { recalled: 2, missed: 2, unrated: 0 });
  const retryAction: PracticeAction = { type: 'retry', ...roundIdentity(complete) };
  const roundTwo = freezeState(active(practiceReducer(complete, retryAction)));
  assert.deepEqual(roundTwo, {
    phase: 'card', session: 1, round: 2, revision: complete.revision + 1, index: 0,
    cards: [cards[0], cards[3]], progress: freshProgress(2),
  });
  assert.equal(roundTwo.cards[0], complete.cards[0]);
  assert.equal(practiceReducer(roundTwo, retryAction), roundTwo);
  for (const action of cardActions(roundTwo))
    assert.equal(practiceReducer(roundTwo, { ...action, round: 1 }), roundTwo);
  const secondComplete = freezeState(finish(roundTwo, [false, true]));
  const roundThree = freezeState(retry(secondComplete));
  assert.equal(roundThree.round, 3);
  assert.equal(roundThree.revision, secondComplete.revision + 1);
  assert.deepEqual(ids(roundThree.cards), [8]);
  assert.deepEqual(roundThree.progress, freshProgress(1));
  for (const round of [1, 2]) {
    assert.equal(practiceReducer(roundThree, { type: 'reveal', ...identity(roundThree), round }), roundThree);
    const revealed = freezeState(reveal(roundThree));
    assert.equal(practiceReducer(revealed, { type: 'rate', ...identity(revealed), round, rating: 'missed' }), revealed);
  }
  const final = finish(roundThree, [true]);
  for (const round of [1, 2, 3])
    assert.equal(practiceReducer(final, { type: 'retry', ...roundIdentity(final), round }), final);
  assert.deepEqual(missedIds(complete), [8, 4]);
  assert.deepEqual(missedIds(secondComplete), [8]);
});

test('exit clears progress in every active phase, keeps the session counter, and rejects stale actions after restart', () => {
  const question = start(pool(1));
  const revealed = reveal(question);
  const partial = results(question);
  const complete = finish(question, [false]);
  const retried = retry(complete);
  for (const state of [question, revealed, partial, complete, retried]) {
    const idle = practiceReducer(freezeState(state), { type: 'exit' });
    assert.deepEqual(idle, { phase: 'idle', session: 1 });
    assert.equal(practiceReducer(idle, { type: 'exit' }), idle);
    assert.equal(practiceReducer(idle, { type: 'start', cards: [] }), idle);
    const fresh = active(practiceReducer(idle, { type: 'start', cards: pool(1) }));
    assert.deepEqual(fresh, { ...question, session: 2 });
    for (const current of [fresh, reveal(fresh)]) {
      for (const action of cardActions(current))
        assert.equal(practiceReducer(current, { ...action, session: 1 }), current);
    }
    for (const current of [results(fresh), finish(fresh, [false])]) {
      for (const type of ['resume', 'retry'] as const)
        assert.equal(practiceReducer(current, { type, ...roundIdentity(current), session: 1 }), current);
    }
    const again = active(practiceReducer(practiceReducer(fresh, { type: 'exit' }), { type: 'start', cards: pool(1) }));
    assert.equal(again.phase, 'card');
    assert.equal(again.session, 3);
    assert.equal(again.round, 1);
    assert.equal(again.revision, 0);
  }
  assert.deepEqual(initialPracticeState, { phase: 'idle', session: 0 });
});

test('start snapshots card content and category IDs independently through navigation and retries', () => {
  const values = [entry(1, { categoryIds: [2, 7] }), entry(2)];
  const sampled = samplePracticeEntries(values, () => 0);
  const before = structuredClone(sampled);
  const question = start(sampled);
  values[0].categoryIds.splice(0, 2, 9);
  values[1].categoryIds.push(4);
  sampled[0].categoryIds.length = 0;
  sampled[1].categoryIds.push(8);
  assert.deepEqual(question.cards, before);
  Object.assign(values[0], entry(20, { translation: '', created: exportedAt }));
  values.length = 0;
  Object.assign(sampled[0], entry(21, { translation: 'Replaced outside the session' }));
  sampled.reverse();
  sampled.length = 0;
  assert.deepEqual(question.cards, before);
  const returned = resume(results(navigate(navigate(question, 'next'), 'previous')));
  assert.equal(returned.cards, question.cards);
  const complete = finish(returned, [false, false]);
  const retried = retry(complete);
  assert.deepEqual(retried.cards, before);
  assert.deepEqual(retried.progress, freshProgress(2));
});

test('library views, navigation and rating edits leave exact database rows and whole-store v2 backups unchanged', async t => {
  const db = await createTestDatabase();
  const { modes } = db;
  const store = await createTestStore({ db });
  t.after(() => store.close());
  const expected = [
    entry(1, { word: 'zulu', translation: 'Shared 中文', categoryIds: [1] }),
    entry(2, { word: 'alpha', translation: '' }),
    entry(3, { word: 'beta', translation: 'Shared English only', created: exportedAt, categoryIds: [1] }),
    entry(4, { word: 'gamma', translation: 'Outside the filter; é; 日本語' }),
  ];
  const batch = {
    categories: ['Reading', 'Unused'],
    entries: expected.map(({ id: _id, categoryIds, ...value }) => ({ ...value, categories: categoryIds.length ? ['Reading'] : [] })),
  };
  assert.deepEqual(await store.importEntries(batch), { imported: 4, updated: 0, skipped: 0, classified: 2, categoriesCreated: 2 });
  const snapshot = await store.snapshot();
  const entries = snapshot.words;
  const original = structuredClone(snapshot);
  const before = await dumpTables(db);
  assert.deepEqual(before, {
    words: expected.map(({ categoryIds: _categoryIds, ...value }) => value),
    categories: [{ id: 1, name: 'Reading', normalized_name: 'reading' }, { id: 2, name: 'Unused', normalized_name: 'unused' }],
    links: [{ word_id: 1, category_id: 1 }, { word_id: 3, category_id: 1 }],
  });
  const backup = serializeBackup(snapshot, exportedAt);
  assert.deepEqual(JSON.parse(backup), { format: 'wordbook', version: 2, exportedAt, ...batch });
  assert.deepEqual(parseBackup(backup), batch);
  modes.length = 0;

  const all = selectLibraryEntries(entries, '', 'recent');
  assert.deepEqual(ids(all), [4, 3, 2, 1]);
  const visible = selectLibraryEntries(entries, ' SHARED ', 'alphabetical', 1);
  assert.deepEqual(ids(visible), [3, 1]);
  assert.deepEqual(ids(selectLibraryEntries(entries, '', 'recent', 'uncategorized')), [4, 2]);
  assert.deepEqual(selectLibraryEntries(entries, '', 'recent', 2), []);
  assert.deepEqual(selectLibraryEntries(entries, '[no results]', 'recent'), []);
  assert.deepEqual(eligiblePracticeEntries(selectLibraryEntries(entries, 'alpha', 'recent')), []);
  assert.deepEqual(await dumpTables(db), before);
  assert.equal(serializeBackup(await store.snapshot(), exportedAt), backup);

  const question = start(samplePracticeEntries(visible, () => 0));
  const skipped = answer(navigate(question, 'next'), false);
  assert.deepEqual(practiceCounts(skipped), { recalled: 0, missed: 1, unrated: 1 });
  const continued = answer(resume(skipped), false);
  const reviewed = answer(continued, true);
  const corrected = answer(navigate(resume(reviewed), 'previous'), true);
  const changedAgain = answer(navigate(corrected, 'previous'), false);
  const complete = results(changedAgain);
  assert.deepEqual(practiceCounts(complete), { recalled: 1, missed: 1, unrated: 0 });
  const retried = retry(complete);
  assert.deepEqual(ids(retried.cards), [3]);
  const final = finish(retried, [true]);
  assert.deepEqual(practiceReducer(final, { type: 'exit' }), { phase: 'idle', session: 1 });
  assert.deepEqual(snapshot, original);
  await store.close();
  assert.deepEqual(await store.list(), original.words);
  assert.deepEqual(await store.snapshot(), original);
  assert.deepEqual(await dumpTables(db), before);
  assert.equal(serializeBackup(await store.snapshot(), exportedAt), backup);
  assert.ok(modes.every(mode => mode === 'read'), 'View, practice, and exports must not open write transactions');
  for (const value of (await dumpTables(db)).words)
    assert.deepEqual(Object.keys(value).sort(), ['created', 'definition', 'example', 'id', 'phonetic', 'pos', 'source', 'translation', 'word']);
});

test('external deletion and import never change navigable snapshots or retries, resurrect entries, or write edited ratings', async t => {
  const db = await createTestDatabase();
  const { modes } = db;
  const store = await createTestStore({ db });
  const peer = await createTestStore({ db });
  t.after(() => Promise.all([store.close(), peer.close()]));
  await store.importEntries({
    categories: ['Shared topic'],
    entries: pool(3).map(({ id: _id, categoryIds: _categoryIds, ...value }) => ({ ...value, categories: ['Shared topic'] })),
  });
  const entries = selectLibraryEntries(await store.list(), '', 'alphabetical', 1);
  const snapshot = structuredClone(entries);
  const question = start(samplePracticeEntries(entries, () => 0));
  let state = answer(question, false);

  await peer.deleteCategory(1);
  for (const value of entries) await peer.remove(value.id);
  await peer.importEntries({
    categories: ['Replacement topic'],
    entries: [
      { ...entry(1), translation: 'Replacement for the same word', created: exportedAt },
      entry(4, { word: 'new import', translation: 'A new eligible answer', created: exportedAt }),
    ].map(({ id: _id, categoryIds: _categoryIds, ...value }) => ({ ...value, categories: ['Replacement topic'] })),
  });
  const refreshedSnapshot = await store.snapshot();
  const refreshed = refreshedSnapshot.words;
  assert.deepEqual(ids(refreshed), [5, 4]);
  assert.equal(refreshed[1].word, snapshot[0].word);
  assert.deepEqual(refreshedSnapshot.categories, [{ id: 2, name: 'Replacement topic' }]);
  assert.ok(refreshed.every(value => value.categoryIds.length === 1 && value.categoryIds[0] === 2));
  const afterExternal = await dumpTables(db);
  const backup = serializeBackup(refreshedSnapshot, exportedAt);
  modes.length = 0;
  entries.forEach(value => {
    value.categoryIds.length = 0;
    Object.assign(value, entry(20, { translation: '' }));
  });
  entries.length = 0;
  assert.deepEqual(question.cards, snapshot);
  const firstReview = navigate(state, 'previous');
  assert.deepEqual(firstReview.cards[0], snapshot[0]);
  state = answer(firstReview, true);
  state = answer(navigate(state, 'previous'), false);
  state = answer(state, false);
  const complete = finish(state, [true]);
  assert.deepEqual(complete.cards, snapshot);
  assert.deepEqual(practiceCounts(complete), { recalled: 1, missed: 2, unrated: 0 });
  const retried = retry(complete);
  assert.deepEqual(retried.cards, snapshot.slice(0, 2));
  assert.deepEqual(ids(retried.cards), [1, 2]);
  const done = finish(resume(results(navigate(retried, 'next'))), [true, true]);
  const idle = practiceReducer(done, { type: 'exit' });
  await store.close();
  const current = await store.list();
  const fresh = active(practiceReducer(idle, { type: 'start', cards: samplePracticeEntries(current, () => 0) }));
  assert.equal(fresh.phase, 'card');
  assert.equal(fresh.session, 2);
  assert.deepEqual(fresh.cards, refreshed);
  assert.deepEqual(await dumpTables(db), afterExternal);
  assert.equal(serializeBackup(await store.snapshot(), exportedAt), backup);
  assert.ok(modes.every(mode => mode === 'read'), 'Only the explicit peer changes may write');
});
