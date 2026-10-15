import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlainNavigation, readRoute, routeHash, routeUrl } from '../src/hash-route';
import type { PageRoute } from '../src/hash-route';

const routes: readonly PageRoute[] = ['words', 'add'];
const primaryActivation: Parameters<typeof isPlainNavigation>[0] = Object.freeze({
  defaultPrevented: false,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
});

function link(target = '', download?: string): Parameters<typeof isPlainNavigation>[1] {
  return {
    target,
    hasAttribute: name => name === 'download' && download !== undefined,
  };
}

test('route hashes are canonical and round-trip for both pages', () => {
  assert.equal(routeHash('words'), '#/words');
  assert.equal(routeHash('add'), '#/add');
  assert.equal(readRoute('#/words'), 'words');
  assert.equal(readRoute('#/add'), 'add');
});

test('empty and unknown hashes fall back to the words page', () => {
  for (const hash of ['', '#', '#/', '#word', '#/unknown', '#/practice']) {
    assert.equal(readRoute(hash), 'words', JSON.stringify(hash));
  }
});

test('route parsing does not normalize case, whitespace, encoding or malformed hashes', () => {
  for (const hash of [
    '#/ADD', '#/Add', '#/adD', '#/WORDS', '#/Words',
    ' #/add', '#/add ', '\n#/add', '#/add\n',
    '#/%61dd', '#%2Fadd', '%23/add', '#/add%20', '#/%',
    'add', '/add', 'words', '/words', '##/add', '#//add',
    '#/add/', '#/words/', '#/add/extra', '#/words/extra',
    '#/add?x=1', '#/words?x=1', '#/add#extra', 'https://example.com/#/add',
  ]) {
    assert.equal(readRoute(hash), 'words', JSON.stringify(hash));
  }
});

test('route URLs preserve root, subpath, page filenames and query strings', () => {
  for (const pageUrl of [
    'https://example.com/',
    'https://example.com/?search=apple&sort=newest',
    'https://example.com/index.html?version=3',
    'https://example.com/wordbook/',
    'https://example.com/wordbook/?search=apple&sort=newest',
    'https://example.com/wordbook/index.html?version=3',
    'https://example.com/wordbook?version=3',
  ]) {
    for (const route of routes) {
      assert.equal(routeUrl(pageUrl, route), `${pageUrl}#/${route}`);
    }
  }
});

test('route URLs replace only the existing fragment and are idempotent on the current route', () => {
  const base = 'https://example.com/wordbook/index.html?search=apple&version=3';
  for (const hash of ['', '#', '#/words', '#/add', '#/ADD', '#unknown', '#/add?ignored=1']) {
    const pageUrl = `${base}${hash}`;
    for (const route of routes) {
      const result = routeUrl(pageUrl, route);
      assert.equal(result, `${base}#/${route}`);
      assert.equal(routeUrl(result, route), result);
      assert.equal(pageUrl, `${base}${hash}`);
    }
  }
});

test('route URLs preserve encoded paths, query values, duplicate parameters and empty values', () => {
  const base = 'https://example.com/word%20book/%E8%AF%8D/index.html'
    + '?search=%E8%AF%8D%20book&tag=a+b&tag=c%2Bd&path=%2f%252F&hash=%23&empty=';
  const pageUrl = `${base}#old%20fragment`;
  for (const route of routes) {
    assert.equal(routeUrl(pageUrl, route), `${base}#/${route}`);
  }
  assert.equal(pageUrl, `${base}#old%20fragment`);
});

test('plain primary clicks and keyboard link activation allow in-page navigation', () => {
  const pointerClick = { ...primaryActivation, detail: 1 };
  const keyboardClick = { ...primaryActivation, detail: 0 };
  assert.equal(isPlainNavigation(pointerClick, link()), true);
  assert.equal(isPlainNavigation(keyboardClick, link()), true);
});

test('each modifier key leaves navigation to the browser', () => {
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
    assert.equal(isPlainNavigation({ ...primaryActivation, [modifier]: true }, link()), false, modifier);
  }
});

test('middle, right and other non-primary buttons are not plain navigation', () => {
  for (const button of [1, 2, 3, -1]) {
    assert.equal(isPlainNavigation({ ...primaryActivation, button }, link()), false, `button ${button}`);
  }
});

test('an already prevented activation is not intercepted', () => {
  assert.equal(isPlainNavigation({ ...primaryActivation, defaultPrevented: true }, link()), false);
});

test('empty and case-insensitive self targets allow plain navigation', () => {
  for (const target of ['', '_self', '_SELF', '_SeLf']) {
    assert.equal(isPlainNavigation(primaryActivation, link(target)), true, JSON.stringify(target));
  }
});

test('other targets and whitespace-padded self targets are not intercepted', () => {
  for (const target of ['_blank', '_BLANK', '_parent', '_top', 'wordbook', 'self', ' _self', '_self ', ' ']) {
    assert.equal(isPlainNavigation(primaryActivation, link(target)), false, JSON.stringify(target));
  }
});

test('download attribute presence prevents interception even with an empty value', () => {
  for (const target of ['', '_self']) {
    assert.equal(isPlainNavigation(primaryActivation, link(target)), true);
    for (const download of ['', 'words.json', 'false']) {
      assert.equal(isPlainNavigation(primaryActivation, link(target, download)), false);
    }
  }
});

test('navigation checks leave event and link inputs unchanged', () => {
  for (const defaultPrevented of [false, true]) {
    const event = Object.freeze({ ...primaryActivation, defaultPrevented });
    const anchor = Object.freeze(link('_SeLf'));
    const originalEvent = { ...event };
    const originalLink = { ...anchor };
    assert.equal(isPlainNavigation(event, anchor), !defaultPrevented);
    assert.deepEqual(event, originalEvent);
    assert.deepEqual(anchor, originalLink);
  }
});
