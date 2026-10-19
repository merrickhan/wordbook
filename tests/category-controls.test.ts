import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryPicker } from '../src/category-picker';
import { CategoryManager } from '../src/category-manager';
import { formatMessage, ui } from '../src/i18n';

const categories = [{ id: 1, name: '<img src=x onerror=alert(1)>' }, { id: 2, name: '旅行场景' }];

test('category pickers escape names and keep each independent selection in native checkboxes', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const html = renderToStaticMarkup(createElement(CategoryPicker, {
      categories, selectedIds: [1], label: ui[locale].categories, locale, disabled: false,
      onChange: () => {}, onCreate: async () => true,
    }));
    assert.match(html, /<details/);
    assert.match(html, /<fieldset/);
    assert.match(html, /type="checkbox" checked=""/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<form/);
    assert.match(html, /maxLength="80"/);
    assert.ok(html.includes(ui[locale].categoriesSelected(1)));
    const empty = renderToStaticMarkup(createElement(CategoryPicker, {
      categories, selectedIds: [], label: ui[locale].importCategories, locale, disabled: true,
      onChange: () => {}, onCreate: async () => true,
    }));
    assert.match(empty, /<fieldset disabled=""/);
    assert.doesNotMatch(empty, /checked=""/);
    assert.ok(empty.includes(ui[locale].categoriesSelected(0)));
  }
});

test('category management labels and destructive confirmations preserve words', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const html = renderToStaticMarkup(createElement(CategoryManager, {
      categories, locale, disabled: true, onCreate: async () => true,
      onRename: async () => {}, onDelete: async () => {},
    }));
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.ok(html.includes(ui[locale].manageCategories));
    assert.ok(ui[locale].confirmDeleteCategory('Travel').includes('Travel'));
  }
  assert.match(ui.en.confirmDeleteCategory('Travel'), /All words will be kept/);
  assert.match(ui['zh-CN'].confirmDeleteCategory('旅行'), /所有单词都会保留/);
});

test('category guidance distinguishes virtual filters and name-based backup merging', () => {
  assert.match(ui.en.emptyUncategorized, /No uncategorized words/);
  assert.doesNotMatch(ui.en.emptyUncategorized, /choose this category/i);
  assert.match(ui['zh-CN'].emptyUncategorized, /没有未分类的单词/);
  assert.doesNotMatch(ui['zh-CN'].emptyUncategorized, /选择此分类/);
  assert.match(ui.en.importMergeHint, /first occurrence supplies both content and categories/);
  assert.match(ui.en.importMergeHint, /older backups may recreate a former category name/);
  assert.match(ui['zh-CN'].importMergeHint, /第一条的内容和分类/);
  assert.match(ui['zh-CN'].importMergeHint, /重新创建改名前的分类/);
});

test('import classification and empty category counts overlap content outcomes without claiming overwrite', () => {
  for (const count of [0, 1, 7]) {
    const message = { code: 'imported' as const, params: {
      imported: 0, updated: 0, skipped: 1, classified: count, categoriesCreated: count,
    } };
    assert.equal(formatMessage('en', message),
      `Added 0 words, overwrote content for 0 words, and skipped content for 1 record. Added category associations to ${count} ${count === 1 ? 'word' : 'words'} and created ${count} ${count === 1 ? 'category' : 'categories'}.`);
    assert.equal(formatMessage('zh-CN', message),
      `已新增 0 个单词，覆盖 0 个单词的内容，跳过 1 条内容；为 ${count} 个单词新增分类关联，新建 ${count} 个分类。`);
    assert.match(formatMessage('en', { code: 'categoriesUpdated', params: { changed: count, unchanged: 1, missing: 2 } }),
      new RegExp(`Changed categories for ${count} .*1 unchanged, 2 no longer present`));
  }
});
