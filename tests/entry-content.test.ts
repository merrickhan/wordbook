import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredEntry } from '../src/entry';
import { EntryContent } from '../src/entry-content';
import { formatDate, sourceLabel, ui, type Locale } from '../src/i18n';

const entry: StoredEntry = {
  id: 1, categoryIds: [9417, 82391], word: 'apple', phonetic: 'US /synthetic/ · UK /synthetic/',
  translation: '合成答案', pos: 'Synthetic noun', definition: 'Synthetic definition',
  example: 'Synthetic example', created: '2024-02-29T12:34:56.789Z',
  source: 'FreeDictionaryAPI.com | Wiktionary: https://en.wiktionary.org/wiki/apple | CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ | 词典摘录，可经编辑',
};

function render(value: StoredEntry, locale: Locale, showPos?: boolean) {
  return renderToStaticMarkup(createElement(EntryContent, { entry: value, locale, showPos }));
}

function savedDate(locale: Locale) {
  return renderToStaticMarkup(createElement('time', { dateTime: entry.created }, formatDate(locale, entry.created)));
}

for (const locale of ['zh-CN', 'en'] as const) {
  const text = ui[locale];

  test(`${locale} library entries without a slot preserve the complete markup and three safe source links`, () => {
    const html = render(entry, locale);
    const expected = '<div class="entry-content"><div class="word-pair has-translation"><div class="word-meta">'
      + `<span class="phonetic" title="${text.accentLabels}">${entry.phonetic}</span><span class="pos">${entry.pos}</span></div>`
      + `<p class="meaning"><span>${entry.translation}</span></p></div><p class="definition">${entry.definition}</p>`
      + `<div class="example"><span>${text.example}</span><p>${entry.example}</p></div><footer>${savedDate(locale)}`
      + `<span class="source">${text.source}<span><a href="https://freedictionaryapi.com/" target="_blank" rel="noopener noreferrer">FreeDictionaryAPI.com</a></span>`
      + `<span> · <a href="https://en.wiktionary.org/wiki/apple" target="_blank" rel="noopener noreferrer">${text.wiktionaryArticle}</a></span>`
      + '<span> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></span>'
      + `<span> · ${text.dictionarySource}</span></span></footer></div>`;
    assert.equal(html, expected);
    assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3);
    assert.equal((html.match(/<footer>/g) || []).length, 1);
  });

  test(`${locale} shared answer content never presents category metadata`, () => {
    const html = render(entry, locale);
    assert.equal(html, render({ ...entry, categoryIds: [] }, locale));
    for (const categoryId of entry.categoryIds) assert.equal(html.includes(String(categoryId)), false);
    assert.doesNotMatch(html, /categoryIds|data-category|class="category/);
  });

  test(`${locale} library showPos=false hides only the repeated part of speech`, () => {
    assert.equal(render(entry, locale, false), render(entry, locale).replace(`<span class="pos">${entry.pos}</span>`, ''));
    const withoutPhonetic = { ...entry, phonetic: '' };
    assert.equal(render(withoutPhonetic, locale, false), render(withoutPhonetic, locale)
      .replace(`<div class="word-meta"><span class="pos">${entry.pos}</span></div>`, ''));
    assert.equal(render(withoutPhonetic, locale, false).includes('class="word-meta"'), false);
  });

  test(`${locale} library entries with missing optional fields retain the meaning placeholder and date`, () => {
    const html = render({ ...entry, phonetic: '', translation: '', pos: '', definition: '', example: '', source: '' }, locale);
    assert.equal(html, '<div class="entry-content"><div class="word-pair">'
      + `<p class="meaning"><span>${text.translationPlaceholder}</span></p></div><footer>${savedDate(locale)}</footer></div>`);
  });

  test(`${locale} library entries retain unlabeled phonetics and plain escaped or localized sources`, () => {
    for (const source of ['Opaque glossary | https://example.test/<entry>?a=1&b="quoted"',
      '手动填写', '用户提供的示例', 'MyMemory（机器翻译）']) {
      const html = render({ ...entry, phonetic: '/synthetic/', source }, locale);
      const expectedSource = renderToStaticMarkup(createElement('span', { className: 'source' }, text.source + sourceLabel(locale, source)));
      assert.ok(html.includes(`<span class="phonetic">/synthetic/<span class="accent-note"> · ${text.unknownAccent}</span></span>`));
      assert.ok(html.includes(`<footer>${savedDate(locale)}${expectedSource}</footer>`));
      assert.equal(html.includes('<a '), false);
      assert.equal(html.includes('<entry>'), false);
    }
  });

  test(`${locale} beforeMetadata inserts nodes immediately before the unchanged unique footer`, () => {
    const beforeMetadata = createElement(Fragment, null,
      createElement('p', { id: 'test-rating-status' }, 'Current rating'),
      createElement('button', { type: 'button' }, 'Rate recall'));
    for (const showPos of [true, false]) {
      const html = renderToStaticMarkup(createElement(EntryContent, { entry, locale, showPos, beforeMetadata }));
      assert.equal(html, render(entry, locale, showPos).replace('<footer>', `${renderToStaticMarkup(beforeMetadata)}<footer>`));
      assert.equal((html.match(/<footer>/g) || []).length, 1);
    }
  });
}
