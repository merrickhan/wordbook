import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPhonetics, hasAccentLabels } from '../src/phonetics';

const ipa = (text: unknown, tags?: unknown) => ({ text, tags });

test('both known accents are shown US first regardless of upstream order', () => {
  assert.deepEqual(formatPhonetics([
    ipa('/təˈmɑː.təʊ/', ['General Australian', 'Received Pronunciation']),
    ipa(' /təˈmeɪ.toʊ/ ', ['US']),
  ]), { phonetic: 'US /təˈmeɪ.toʊ/ · UK /təˈmɑː.təʊ/', omitted: false });
});

test('single confirmed accents suppress unknown and unrelated-region variants', () => {
  for (const [tag, label] of [['US', 'US'], ['General American', 'US'], ['UK', 'UK'], ['Received Pronunciation', 'UK']]) {
    assert.deepEqual(formatPhonetics([
      ipa('/unknown/'), ipa('/other/', ['Canada']), ipa('/confirmed/', [tag]),
    ]), { phonetic: label + ' /confirmed/', omitted: false });
  }
});

test('exact tags ignore case and whitespace, never infer regions from substrings', () => {
  assert.equal(formatPhonetics([
    ipa('/one/', [null, {}, 42, ['US'], 'uS eNgLiSh', 'Latin American']),
    ipa('/two/', 'US'), ipa('/three/', { region: 'UK' }),
    ipa('/four/', [false, ' gEnErAl AmErIcAn ']),
    ipa('/five/', [' Received Pronunciation ']),
  ]).phonetic, 'US /four/ · UK /five/');
  for (const tags of [undefined, null, 'US', { region: 'US' }, ['American'], ['British'], ['US English'], ['Northern England']]) {
    assert.equal(formatPhonetics([ipa('/first/', tags), ipa('/next/', ['Canada'])]).phonetic, '/first/');
  }
});

test('first valid IPA per accent wins without collapsing equal US and UK values', () => {
  assert.equal(formatPhonetics([
    ipa('/shared/', ['US', 'UK']), ipa('/later/', ['General American']),
  ]).phonetic, 'US /shared/ · UK /shared/');
  assert.equal(formatPhonetics([
    ipa(null, ['US']), ipa({}, ['UK']), ipa(' ', ['US']),
    ipa('/first/', ['General American']), ipa('/second/', ['US']),
    ipa('[british]', ['UK']), ipa('/later/', ['Received Pronunciation']),
  ]).phonetic, 'US /first/ · UK [british]');
});

test('missing accents preserve the first nonempty raw IPA and empty inputs stay empty', () => {
  assert.deepEqual(formatPhonetics([ipa(''), ipa(null), ipa(' [bæθ] ', ['Canada']), ipa('/later/')]),
    { phonetic: '[bæθ]', omitted: false });
  assert.deepEqual(formatPhonetics([]), { phonetic: '', omitted: false });
  assert.deepEqual(formatPhonetics([ipa(' '), ipa(1), ipa({})]), { phonetic: '', omitted: false });
});

test('the full 2000-character budget includes accent labels and separators', () => {
  const long = '/' + 'a'.repeat(1995) + '/';
  assert.deepEqual(formatPhonetics([ipa(long, ['US'])]), { phonetic: 'US ' + long, omitted: false });
  assert.deepEqual(formatPhonetics([ipa(long + 'a', ['US'])]), { phonetic: '', omitted: true });
  const american = '/' + 'a'.repeat(1984) + '/';
  const british = '[bθ]';
  assert.equal(('US ' + american + ' · UK ' + british).length, 1999);
  assert.deepEqual(formatPhonetics([ipa(american + 'a', ['US']), ipa(british, ['UK'])]),
    { phonetic: 'US ' + american + 'a · UK ' + british, omitted: false });
  assert.deepEqual(formatPhonetics([ipa(american + 'aa', ['US']), ipa(british, ['UK'])]),
    { phonetic: 'US ' + american + 'aa', omitted: true });
});

test('oversized segments are omitted whole, with no relabeling or later-IPA substitution', () => {
  const huge = '/' + 'ɪ'.repeat(2000) + '/';
  assert.deepEqual(formatPhonetics([ipa(huge, ['US']), ipa('/later-us/', ['US']), ipa('[uk]', ['UK'])]),
    { phonetic: 'UK [uk]', omitted: true });
  assert.deepEqual(formatPhonetics([ipa(huge, ['US']), ipa(huge, ['UK']), ipa('/untagged/')]),
    { phonetic: '', omitted: true });
  assert.deepEqual(formatPhonetics([ipa(huge), ipa('/later/')]), { phonetic: '', omitted: true });
  const raw = '𐞁'.repeat(1000);
  assert.deepEqual(formatPhonetics([ipa(raw)]), { phonetic: raw, omitted: false });
  assert.deepEqual(formatPhonetics([ipa(raw + '𐞁')]), { phonetic: '', omitted: true });
});

test('display recognizes complete explicit labels without mutating raw values', () => {
  for (const value of ['US /a/', 'UK [b]', 'US /a/ · UK [b]', 'UK [b] · US /a/', ' US /a/ ']) {
    assert.equal(hasAccentLabels(value), true, value);
  }
  for (const value of ['', '/a/', '[b]', 'us /a/', 'USA /a/', 'US', 'US ', 'US  /a/',
    'US /a/ · ', 'US /a/ · /b/', 'US /a/ · US /b/', 'CA /a/', 'US /a/ · UK /b/ · CA /c/']) {
    assert.equal(hasAccentLabels(value), false, value);
  }
});
