import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredEntry } from '../src/entry';
import { ui, type Locale } from '../src/i18n';
import { PracticePanel } from '../src/practice-panel';
import type { ActivePractice, PracticeRating } from '../src/practice';

const entry: StoredEntry = {
  id: 1, word: 'apple', phonetic: 'US /synthetic/ · UK /synthetic/',
  translation: '合成答案', pos: 'Synthetic noun', definition: 'Synthetic definition',
  example: 'Synthetic example', created: '2024-02-29T12:34:56.789Z',
  source: 'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/apple | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑',
};
const round: ActivePractice = {
  phase: 'card', session: 1, round: 1, revision: 0, index: 0,
  cards: [entry], progress: [{ revealed: false, rating: null }],
};

function render(state: ActivePractice, locale: Locale) {
  return renderToStaticMarkup(createElement(PracticePanel, {
    state, locale, dispatch: () => {}, onExit: () => {}, onSpeak: () => {},
  }));
}

function button(html: string, label: string) {
  const matches = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.filter(value => value.includes(label)) || [];
  assert.equal(matches.length, 1, `one button named ${label}`);
  return matches[0];
}

function inOrder(html: string, ...markers: string[]) {
  let previous = -1;
  for (const marker of markers) {
    const position = html.indexOf(marker);
    assert.ok(position > previous, `${marker} appears in reading order`);
    previous = position;
  }
}

function currentRating(html: string, label: string) {
  assert.equal(html.split('id="practice-rating-status"').length - 1, 1);
  assert.equal(html.split(label).length - 1, 1);
  assert.ok(html.includes(`<p id="practice-rating-status" class="practice-rating-status">${label}</p>`));
  assert.ok(html.includes('aria-describedby="practice-progress practice-instruction practice-rating-status"'));
  for (const id of ['practice-progress', 'practice-instruction'])
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
}

for (const locale of ['zh-CN', 'en'] as const) {
  const text = ui[locale];
  test(`${locale} fresh practice cards expose the word, navigation and unrated status without mounting answers`, () => {
    const html = render(round, locale);
    assert.ok(html.includes(entry.word));
    assert.ok(html.includes(text.speak(entry.word)));
    assert.ok(html.includes(text.showAnswer));
    currentRating(html, text.practiceCurrentRating(text.practiceUnrated));
    assert.ok(html.includes(text.practiceRated(0, 1)));
    assert.ok(html.includes(text.viewPracticeResults));
    inOrder(html, 'class="practice-navigation"', 'class="practice-word"', text.speak(entry.word),
      'id="practice-instruction"', 'id="practice-rating-status"', 'class="primary reveal-answer"',
      'class="text-button practice-view-results"', text.practiceNavigationHint, text.practiceSessionOnly);
    assert.equal(html.includes('<footer>'), false);
    for (const content of [entry.phonetic, entry.translation, entry.pos, entry.definition, entry.example, entry.created,
      'FreeDictionaryAPI.com', 'Wiktionary', 'CC BY-SA', text.didNotRecall, text.recalledCorrectly])
      assert.equal(html.includes(content), false, content);
    assert.equal(html.includes('practice-answer'), false);
    assert.match(button(html, text.previousWord), /disabled=""/);
    assert.match(button(html, text.nextWord), /disabled=""/);
  });

  test(`${locale} navigation disables only the corresponding boundary and exposes the current word`, () => {
    const cards = [entry, { ...entry, id: 2, word: 'book' }, { ...entry, id: 3, word: 'candle' }];
    for (const index of [0, 1, 2]) {
      const html = render({ ...round, cards, index, progress: cards.map(() => ({ revealed: false, rating: null })) }, locale);
      const previous = button(html, text.previousWord);
      const next = button(html, text.nextWord);
      assert.equal(previous.includes('disabled=""'), index === 0);
      assert.equal(next.includes('disabled=""'), index === 2);
      for (const label of [text.previousWord, text.nextWord]) {
        const navigationButton = button(html, label);
        assert.ok(navigationButton.includes(`aria-label="${label}"`));
        assert.ok(navigationButton.includes(`<span class="practice-navigation-label">${label}</span>`));
        assert.match(navigationButton, /<svg\b[^>]*aria-hidden="true"/);
      }
      assert.ok(html.includes(`<span lang="en">${cards[index].word}</span>`));
      const progress = `<p id="practice-progress" class="practice-progress"><span>${text.practiceProgress(index + 1, 3)}</span><span>${text.practiceRated(0, 3)}</span></p>`;
      assert.ok(html.includes(`<div class="practice-navigation" role="group" aria-label="${text.practiceNavigation}">${previous}${progress}${next}</div>`));
      assert.equal(html.split('class="practice-navigation"').length - 1, 1);
      currentRating(html, text.practiceCurrentRating(text.practiceUnrated));
    }
  });

  test(`${locale} revealed cards include complete safe attribution and editable selected ratings`, () => {
    for (const rating of [null, 'missed', 'recalled'] as const) {
      const html = render({ ...round, progress: [{ revealed: true, rating }] }, locale);
      for (const content of [entry.word, entry.phonetic, entry.translation, entry.pos, entry.definition, entry.example, entry.created,
        'FreeDictionaryAPI.com', 'https://en.wiktionary.org/wiki/apple', 'https://creativecommons.org/licenses/by-sa/4.0/',
        text.didNotRecall, text.recalledCorrectly, text.practiceRatingHint]) assert.ok(html.includes(content), content);
      assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3);
      assert.equal(html.includes('<details'), false);
      assert.equal(html.includes(text.deleteWord(entry.word)), false);
      assert.equal(html.includes(text.save), false);
      assert.equal(html.includes('class="primary reveal-answer"'), false);
      assert.equal(button(html, text.didNotRecall).includes('aria-pressed="true"'), rating === 'missed');
      assert.equal(button(html, text.recalledCorrectly).includes('aria-pressed="true"'), rating === 'recalled');
      assert.ok(html.includes(text.practiceRated(rating === null ? 0 : 1, 1)));
      currentRating(html, text.practiceCurrentRating(rating === 'recalled' ? text.recalledCorrectly
        : rating === 'missed' ? text.didNotRecall : text.practiceUnrated));
      assert.equal((html.match(/<footer>/g) || []).length, 1);
      assert.equal(html.split('class="practice-navigation"').length - 1, 1);
      inOrder(html, 'class="practice-word"', text.speak(entry.word), 'id="practice-instruction"',
        'class="practice-answer"', text.savedAnswer, 'class="entry-content"', entry.phonetic, entry.pos,
        entry.translation, entry.definition, entry.example, 'id="practice-rating-status"',
        `role="group" aria-label="${text.rateRecall}"`, button(html, text.didNotRecall), button(html, text.recalledCorrectly),
        text.practiceRatingHint, '<footer>', entry.created, 'class="source"', '</footer>',
        'class="text-button practice-view-results"', text.practiceNavigationHint, text.practiceSessionOnly);
    }
  });

  test(`${locale} summaries distinguish unrecalled from unrated, gate retries and retain a return-to-round action`, () => {
    const cases: (PracticeRating | null)[][] = [[null, null], ['recalled', null], ['missed', null],
      ['recalled', 'missed'], ['missed', 'missed'], ['recalled', 'recalled']];
    for (const ratings of cases) {
      const recalled = ratings.filter(value => value === 'recalled').length;
      const missed = ratings.filter(value => value === 'missed').length;
      const unrated = ratings.filter(value => value === null).length;
      const html = render({
        ...round, phase: 'summary', index: 1, cards: [entry, { ...entry, id: 2, word: 'book' }],
        progress: ratings.map(rating => ({ revealed: rating !== null, rating })),
      }, locale);
      assert.ok(html.includes(text.practiceResult(recalled, 2)));
      const breakdown = html.match(/<dl id="practice-result-breakdown" class="practice-result-breakdown">[\s\S]*?<\/dl>/)?.[0];
      assert.ok(breakdown);
      assert.equal((breakdown.match(/<dt>/g) || []).length, 3);
      assert.ok(breakdown.includes(`<dt>${text.recalledCorrectly}</dt><dd>${recalled}</dd>`));
      assert.ok(breakdown.includes(`<dt>${text.didNotRecall}</dt><dd>${missed}</dd>`));
      assert.ok(breakdown.includes(`<dt>${text.practiceUnrated}</dt><dd>${unrated}</dd>`));
      assert.equal(html.includes(text.practiceComplete), unrated === 0);
      assert.equal(html.includes(text.practiceAllRecalled), recalled === 2);
      assert.equal(html.includes(text.retryMissed), unrated === 0 && missed > 0);
      assert.equal(html.includes(text.continueUnrated), unrated > 0);
      assert.equal(html.includes(text.reviewRound), unrated === 0);
      if (unrated) assert.ok(html.includes(text.practiceUnratedRemaining(unrated)));
      else assert.match(button(html, text.reviewRound), /class="secondary"/);
      const primary = html.match(/<button\b[^>]*class="primary"[^>]*>[\s\S]*?<\/button>/g) || [];
      assert.equal(primary.length, 1);
      assert.ok(primary[0].includes(unrated ? text.continueUnrated : missed ? text.retryMissed : text.backToWords));
      assert.equal(button(html, text.backToWords).includes('class="primary"'), unrated === 0 && missed === 0);
      assert.equal(html.includes(entry.translation), false);
      assert.equal(html.includes('practice-answer'), false);
    }
  });
}
