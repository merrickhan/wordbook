// Keep the notebook in browser storage; only autofill requests external dictionaries and translation.
import { useState, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useCallback, type MouseEvent } from 'react';
import {
  Search,
  Check,
  LoaderCircle,
  PenLine,
  Volume2,
  Download,
  Upload,
  Trash2,
  X,
} from 'lucide-react';
import { createEntry, sample, validWord, type Entry, type StoredEntry } from './entry';
import { hasMyMemorySource, lookup as queryWord } from './vocabulary';
import { createWordStore, databaseName } from './storage';
import { MAX_BACKUP_BYTES, parseBackup, serializeBackup } from './backup';
import { errorMessage, MessageError, type Message } from './messages';
import { ui, formatMessage, readLocale, writeLocale, type Locale } from './i18n';
import { dictionaryProviders, isDictionaryProvider, readDictionaryProvider, writeDictionaryProvider, removeLegacyTranslationPreferences, type DictionaryProvider } from './dictionary-providers';
import { EntryContent, Phonetic, Source } from './entry-content';
import { paginateLibraryEntries, selectLibraryEntries, type LibrarySort } from './library';
import { eligiblePracticeEntries, initialPracticeState, practiceReducer, samplePracticeEntries } from './practice';
import { PracticePanel } from './practice-panel';
import { isPlainNavigation, readRoute, routeHash, routeUrl, type PageRoute } from './hash-route';
import type { Category, CategoryChange, CategoryFilter, LibrarySnapshot } from './categories';
import { CategoryPicker } from './category-picker';
import { CategoryManager } from './category-manager';

const dbNamespace = databaseName(window.location.href);
const store = createWordStore({ name: dbNamespace });
type Operation = '' | 'save' | 'delete' | 'import' | 'export' | 'category' | 'classify';
type CategoryTarget = 'draft' | 'import' | 'bulk';
type NavigationTarget = 'words' | 'add' | 'capture' | 'import' | 'practice-return';
type NavigationIntent = { route: PageRoute; target: NavigationTarget; revision: number };

export default function Home() {
  const [locale, setLocale] = useState<Locale>(() => readLocale(dbNamespace));
  const localeRef = useRef(locale);
  const [provider, setProvider] = useState<DictionaryProvider>(() => readDictionaryProvider(dbNamespace));
  const providerRef = useRef(provider);
  const text = ui[locale];
  const [notebook, setNotebook] = useState<LibrarySnapshot>({ words: [], categories: [] }),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState<Message | null>(null),
    [storeReady, setStoreReady] = useState(false);
  const [input, setInput] = useState(''),
    [draft, setDraft] = useState<Entry | null>(null),
    [warnings, setWarnings] = useState<Message[]>([]),
    [querying, setQuerying] = useState(false),
    [operation, setOperation] = useState<Operation>(''),
    [error, setError] = useState<Message | null>(null),
    [notice, setNotice] = useState<Message | null>(null);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const active = useRef(false);
  const ready = useRef(false);
  const operationLock = useRef<Operation>('');
  const listRequest = useRef(0);
  const queryRequest = useRef(0);
  const queryController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const wordsPage = useRef<HTMLElement>(null);
  const collectionHeading = useRef<HTMLHeadingElement>(null);
  const addHeading = useRef<HTMLHeadingElement>(null);
  const captureHeading = useRef<HTMLHeadingElement>(null);
  const importHeading = useRef<HTMLHeadingElement>(null);
  const practiceStart = useRef<HTMLButtonElement>(null);
  const librarySearch = useRef<HTMLInputElement>(null);
  const libraryScroll = useRef({ x: 0, y: 0 });
  const [route, setRoute] = useState(() => readRoute(window.location.hash));
  const routeRef = useRef(route);
  const acceptedUrl = useRef(window.location.href);
  const pendingNavigation = useRef<NavigationIntent | null>(null);
  const navigationSequence = useRef(0);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('recent');
  const [libraryPage, setLibraryPage] = useState(1);
  const pageTurnFocus = useRef(false);
  const [practice, dispatchPractice] = useReducer(practiceReducer, initialPracticeState);
  const practicing = useRef(false);
  const { words, categories } = notebook;
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const categoryFilterRef = useRef<CategoryFilter>('all');
  const [draftCategories, setDraftCategories] = useState<number[]>([]);
  const [importCategories, setImportCategories] = useState<number[]>([]);
  const [bulkCategories, setBulkCategories] = useState<number[]>([]);
  const [categoryAction, setCategoryAction] = useState<CategoryChange['mode']>('add');
  const [selecting, setSelecting] = useState(false);
  const [selectedWordIds, setSelectedWordIds] = useState<number[]>([]);
  const selectionRevision = useRef(0);
  const selectionStart = useRef<HTMLButtonElement>(null);
  const selectedWords = useMemo(() => new Set(selectedWordIds), [selectedWordIds]);
  const categoryNames = useMemo(() => new Map(categories.map(category => [category.id, category.name])), [categories]);
  const results = useMemo(() => selectLibraryEntries(words, libraryQuery, librarySort, categoryFilter),
    [words, libraryQuery, librarySort, categoryFilter]);
  const outsideSelection = selectedWordIds.length - results.filter(entry => selectedWords.has(entry.id)).length;
  const eligible = useMemo(() => eligiblePracticeEntries(results), [results]);
  const page = paginateLibraryEntries(results, libraryPage);
  const cancelSelection = useCallback(() => {
    selectionRevision.current++;
    setSelecting(false);
    setSelectedWordIds([]);
  }, []);

  function changeCategoryFilter(next: CategoryFilter) {
    categoryFilterRef.current = next;
    setCategoryFilter(next);
    setLibraryPage(1);
    cancelSelection();
  }

  function selectEntries(entries: readonly StoredEntry[]) {
    if (operationLock.current) return;
    setSelectedWordIds(previous => [...new Set([...previous, ...entries.map(entry => entry.id)])]);
  }

  // Mount-only listeners and tools share this entry point, using current refs rather than their first render.
  const navigate = useCallback((next: PageRoute, target?: NavigationTarget, push = true) => {
    const liveRoute = readRoute(window.location.hash);
    const canonicalUrl = routeUrl(window.location.href, liveRoute);
    if (canonicalUrl !== window.location.href)
      window.history.replaceState(window.history.state, '', canonicalUrl);
    if (push && liveRoute !== next)
      window.history.pushState(null, '', routeUrl(canonicalUrl, next));
    acceptedUrl.current = window.location.href;

    if (next === routeRef.current && !practicing.current && !target) return;
    // The DOM may still show the previous surface during rapid, batched transitions.
    if (wordsPage.current && !wordsPage.current.hidden)
      libraryScroll.current = { x: window.scrollX, y: window.scrollY };
    const destination = target ?? (next === 'words' && practicing.current ? 'practice-return' : next);
    routeRef.current = next;
    practicing.current = false;
    pageTurnFocus.current = false;
    const revision = ++navigationSequence.current;
    pendingNavigation.current = { route: next, target: destination, revision };
    setRoute(next);
    setNavigationRevision(revision);
    cancelSelection();
    dispatchPractice({ type: 'exit' });
  }, [cancelSelection]);

  useLayoutEffect(() => {
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    const synchronize = () => {
      if (window.location.href !== acceptedUrl.current)
        navigate(readRoute(window.location.hash), undefined, false);
    };
    const canonicalUrl = routeUrl(window.location.href, readRoute(window.location.hash));
    if (canonicalUrl !== window.location.href)
      window.history.replaceState(window.history.state, '', canonicalUrl);
    synchronize();
    window.addEventListener('hashchange', synchronize);
    return () => {
      window.removeEventListener('hashchange', synchronize);
      window.history.scrollRestoration = previousRestoration;
    };
  }, [navigate]);

  useLayoutEffect(() => {
    // Keep the clamped page, even if a later refresh grows the results again.
    if (libraryPage !== page.page) setLibraryPage(page.page);
  }, [libraryPage, page.page]);

  useLayoutEffect(() => {
    if (!pageTurnFocus.current) return;
    pageTurnFocus.current = false;
    if (route !== 'words' || routeRef.current !== 'words' || practice.phase !== 'idle') return;
    collectionHeading.current?.focus({ preventScroll: true });
    collectionHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [libraryPage, practice.phase, route]);

  useLayoutEffect(() => {
    const intent = pendingNavigation.current;
    if (!intent || intent.revision !== navigationRevision || intent.route !== route || practice.phase !== 'idle') return;
    pendingNavigation.current = null;
    const target = intent.target === 'practice-return'
      ? practiceStart.current && !practiceStart.current.disabled ? practiceStart.current : collectionHeading.current
      : intent.target === 'words' ? collectionHeading.current
      : intent.target === 'import' ? importHeading.current
      : intent.target === 'capture' ? captureHeading.current : addHeading.current;
    target?.focus({ preventScroll: true });
    if (route === 'words') {
      window.scrollTo({ left: libraryScroll.current.x, top: libraryScroll.current.y, behavior: 'instant' });
    } else {
      target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [route, navigationRevision, practice.phase]);

  function followRoute(event: MouseEvent<HTMLAnchorElement>, next: PageRoute, target?: NavigationTarget) {
    if (!isPlainNavigation(event, event.currentTarget)) return;
    event.preventDefault();
    navigate(next, target);
  }

  function startPractice() {
    if (routeRef.current !== 'words' || practicing.current || loading || !ready.current || operationLock.current || !eligible.length) return;
    const cards = samplePracticeEntries(eligible);
    libraryScroll.current = { x: window.scrollX, y: window.scrollY };
    pendingNavigation.current = null;
    navigationSequence.current++;
    pageTurnFocus.current = false;
    practicing.current = true;
    cancelSelection();
    dispatchPractice({ type: 'start', cards });
  }

  function changeLibraryPage(next: number) {
    if (routeRef.current !== 'words' || practicing.current || next < 1 || next > page.pageCount || next === page.page) return;
    pageTurnFocus.current = true;
    setLibraryPage(next);
  }

  function clearLibrarySearch() {
    setLibraryQuery('');
    setLibraryPage(1);
    cancelSelection();
    if (routeRef.current === 'words' && !practicing.current) librarySearch.current?.focus();
  }

  function clearFilters() {
    changeCategoryFilter('all');
    clearLibrarySearch();
  }

  function switchLocale(next: Locale) {
    localeRef.current = next;
    setLocale(next);
    writeLocale(dbNamespace, next);
  }

  useEffect(() => {
    document.documentElement.lang = locale;
    const title = practice.phase !== 'idle' ? ui[locale].practiceTitle
      : route === 'add' ? ui[locale].addWord : ui[locale].myWords;
    document.title = `${title} · Wordbook`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', ui[locale].pageDescription);
  }, [locale, route, practice.phase]);

  async function refresh(silent = false) {
    const request = ++listRequest.current;
    if (!silent) setLoading(true);
    try {
      const snapshot = await store.snapshot();
      if (!active.current || request !== listRequest.current) return;
      setNotebook(snapshot);
      const categoryIds = new Set(snapshot.categories.map(category => category.id));
      const wordIds = new Set(snapshot.words.map(entry => entry.id));
      setDraftCategories(previous => previous.filter(id => categoryIds.has(id)));
      setImportCategories(previous => previous.filter(id => categoryIds.has(id)));
      setBulkCategories(previous => previous.filter(id => categoryIds.has(id)));
      setSelectedWordIds(previous => previous.filter(id => wordIds.has(id)));
      if (typeof categoryFilterRef.current === 'number' && !categoryIds.has(categoryFilterRef.current))
        changeCategoryFilter('all');
      setLoadError(null);
      ready.current = true;
      setStoreReady(true);
    } catch (error) {
      if (!active.current || request !== listRequest.current) return;
      setLoadError({ code: 'loadFailed', params: { reason: errorMessage(error) } });
      ready.current = false;
      setStoreReady(false);
    } finally {
      if (active.current && request === listRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    removeLegacyTranslationPreferences(dbNamespace, () => window.localStorage);
    void refresh();
    const onFocus = () => {
      if (!operationLock.current) void refresh(true);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      listRequest.current++;
      queryRequest.current++;
      queryController.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  function cancelLookup() {
    queryRequest.current++;
    queryController.current?.abort();
    queryController.current = null;
    setQuerying(false);
  }

  function switchProvider(next: string) {
    if (operationLock.current || !isDictionaryProvider(next) || next === providerRef.current) return;
    cancelLookup();
    providerRef.current = next;
    setProvider(next);
    writeDictionaryProvider(dbNamespace, next);
  }

  async function lookup(word: string) {
    if (operationLock.current) throw new MessageError({ code: 'operationBusy' });
    const selectedProvider = providerRef.current;
    queryController.current?.abort();
    const controller = new AbortController();
    queryController.current = controller;
    const request = ++queryRequest.current;
    setError(null);
    setNotice(null);
    setQuerying(true);
    setDraft(null);
    setWarnings([]);
    try {
      const result = await queryWord(word, undefined, controller.signal, selectedProvider);
      if (active.current && request === queryRequest.current) {
        setDraft(result.entry);
        setWarnings(result.warnings);
      }
      return result;
    } catch (error) {
      if (active.current && request === queryRequest.current && !controller.signal.aborted)
        setError(errorMessage(error));
      throw error;
    } finally {
      if (active.current && request === queryRequest.current) {
        setQuerying(false);
        queryController.current = null;
      }
    }
  }

  function openDraft(entry: Entry) {
    if (operationLock.current) return;
    cancelLookup();
    setDraft({ ...entry });
    setInput(entry.word);
    setWarnings([]);
    setError(null);
    setNotice(null);
  }

  function manualEntry() {
    if (!validWord(input)) {
      setError({ code: 'manualInvalidWord' });
      return;
    }
    openDraft(createEntry(input));
  }

  // Lock synchronously with a ref to prevent rapid submissions before disabled takes effect.
  function beginOperation(next: Operation, confirmation?: string) {
    if (operationLock.current) return false;
    if (!ready.current) {
      setError({ code: 'storeNotReady' });
      return false;
    }
    operationLock.current = next;
    if (confirmation && !window.confirm(confirmation)) {
      operationLock.current = '';
      return false;
    }
    if (next !== 'export') {
      listRequest.current++;
      setLoading(false);
    }
    setOperation(next);
    setError(null);
    setNotice(null);
    return true;
  }
  function endOperation() {
    operationLock.current = '';
    if (active.current) setOperation('');
  }

  async function save() {
    if (!draft || !beginOperation('save')) return;
    try {
      await store.save(draft, [...draftCategories]);
      if (!active.current) return;
      setDraft(null);
      setInput('');
      setWarnings([]);
      setNotice({ code: 'saved' });
      // refresh reports its own read errors without misreporting a committed save as a failure.
      await refresh(true);
    } catch (error) {
      if (active.current) setError(errorMessage(error));
    } finally {
      endOperation();
    }
  }

  async function remove(entry: StoredEntry, trigger: HTMLButtonElement) {
    if (!beginOperation('delete', ui[localeRef.current].confirmDelete(entry.word))) return;
    try {
      await store.remove(entry.id);
      if (!active.current) return;
      if (routeRef.current === 'words' && !practicing.current && wordsPage.current && !wordsPage.current.hidden
        && document.activeElement === trigger && document.hasFocus()) {
        const article = trigger.closest('article');
        const next = article?.nextElementSibling?.querySelector<HTMLElement>('summary')
          ?? article?.previousElementSibling?.querySelector<HTMLElement>('summary')
          ?? collectionHeading.current;
        next?.focus({ preventScroll: true });
      }
      setNotice({ code: 'deleted', params: { word: entry.word } });
      await refresh(true);
    } catch (error) {
      if (active.current) setError({ code: 'deleteFailed', params: { reason: errorMessage(error) } });
    } finally {
      endOperation();
    }
  }

  async function exportBackup() {
    if (!beginOperation('export')) return;
    try {
      const backup = serializeBackup(await store.snapshot());
      if (!active.current) return;
      const url = URL.createObjectURL(new Blob([backup], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'wordbook-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ code: 'exported' });
    } catch (error) {
      if (active.current) setError(errorMessage(error));
    } finally {
      endOperation();
    }
  }

  async function importBackup(file: File, overwriteExisting: boolean, categoryIds: readonly number[]) {
    if (!beginOperation('import')) return;
    const selectedCategoryIds = [...categoryIds];
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new MessageError({ code: 'importFileTooLarge' });
      const entries = parseBackup(await file.text());
      const result = await store.importEntries(entries, { overwriteExisting, selectedCategoryIds });
      if (!active.current) return;
      setNotice({ code: 'imported', params: result });
      await refresh(true);
    } catch (error) {
      if (active.current) setError({ code: 'importFailed', params: { reason: errorMessage(error) } });
    } finally {
      endOperation();
    }
  }

  async function createCategory(name: string, target?: CategoryTarget): Promise<boolean> {
    if (!beginOperation('category')) return false;
    const navigation = navigationSequence.current;
    const selection = selectionRevision.current;
    try {
      const category = await store.createCategory(name);
      if (!active.current) return false;
      if (navigation === navigationSequence.current && (target !== 'bulk' || selection === selectionRevision.current)) {
        const setSelection = target === 'draft' ? setDraftCategories : target === 'import' ? setImportCategories : target === 'bulk' ? setBulkCategories : null;
        setSelection?.(previous => [...new Set([...previous, category.id])]);
      }
      setNotice({ code: 'categorySaved' });
      await refresh(true);
      return true;
    } catch (error) {
      if (active.current) {
        setError(errorMessage(error));
        await refresh(true);
      }
      return false;
    } finally {
      endOperation();
    }
  }

  async function renameCategory(id: number, name: string) {
    if (!beginOperation('category')) return;
    try {
      await store.renameCategory(id, name);
      if (!active.current) return;
      setNotice({ code: 'categorySaved' });
      await refresh(true);
    } catch (error) {
      if (active.current) {
        setError(errorMessage(error));
        await refresh(true);
      }
    } finally {
      endOperation();
    }
  }

  async function deleteCategory(category: Category, trigger: HTMLButtonElement) {
    if (!beginOperation('category', ui[localeRef.current].confirmDeleteCategory(category.name))) return;
    try {
      await store.deleteCategory(category.id);
      if (!active.current) return;
      if (routeRef.current === 'words' && !practicing.current && document.activeElement === trigger && document.hasFocus())
        trigger.closest('details')?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
      setNotice({ code: 'categoryDeleted' });
      await refresh(true);
    } catch (error) {
      if (active.current) {
        setError(errorMessage(error));
        await refresh(true);
      }
    } finally {
      endOperation();
    }
  }

  async function applyCategories(trigger: HTMLButtonElement) {
    if (!selectedWordIds.length || (categoryAction !== 'clear' && !bulkCategories.length)) return;
    const ids = [...selectedWordIds];
    const change: CategoryChange = categoryAction === 'clear'
      ? { mode: 'clear' } : { mode: categoryAction, categoryIds: [...bulkCategories] };
    const copy = ui[localeRef.current];
    const confirmation = change.mode === 'replace' ? copy.confirmReplaceCategories(ids.length)
      : change.mode === 'clear' ? copy.confirmClearCategories(ids.length) : undefined;
    if (!beginOperation('classify', confirmation)) return;
    const selection = selectionRevision.current;
    try {
      const result = await store.updateWordCategories(ids, change);
      if (!active.current) return;
      if (selection === selectionRevision.current) {
        if (routeRef.current === 'words' && !practicing.current && document.activeElement === trigger && document.hasFocus())
          collectionHeading.current?.focus({ preventScroll: true });
        cancelSelection();
      }
      setNotice({ code: 'categoriesUpdated', params: result });
      await refresh(true);
    } catch (error) {
      if (active.current) {
        setError(errorMessage(error));
        await refresh(true);
      }
    } finally {
      endOperation();
    }
  }

  useEffect(() => {
    const context = (document as any).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      Promise.resolve(
        context.registerTool(
          {
            name: 'prepare_vocabulary_entry',
            title: 'Look up a word and open an editable draft',
            description: 'Look up the IPA transcription, Chinese meaning, and example for an English word. Open a draft for review without saving it.',
            inputSchema: {
              type: 'object',
              properties: { word: { type: 'string', maxLength: 80 } },
              required: ['word'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute: async (value: unknown) => {
              const word = (value as { word?: unknown } | null)?.word;
              if (!validWord(word)) throw new Error('Invalid word');
              try {
                if (operationLock.current) throw new MessageError({ code: 'operationBusy' });
                navigate('add', 'capture');
                setInput(word);
                const result = await lookup(word);
                return {
                  ...result,
                  warnings: result.warnings.map((warning) => formatMessage(localeRef.current, warning)),
                };
              } catch (error) {
                if (error instanceof MessageError)
                  throw new Error(formatMessage(localeRef.current, error.detail), { cause: error });
                throw error;
              }
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(console.error);
    } catch (error) {
      console.error(error);
    }
    return () => lifecycle.abort();
  }, []);

  function speak(word: string) {
    if (!('speechSynthesis' in window)) {
      setNotice({ code: 'speechUnsupported' });
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    const voices = window.speechSynthesis.getVoices()
      .filter((voice) => voice.lang.replace('_', '-').toLowerCase() === 'en-us');
    const voice = voices.find((voice) => voice.default) || voices[0];
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  function field(key: Exclude<keyof Entry, 'source'>, label: string) {
    if (!draft) return null;
    const multiline = key === 'translation' || key === 'definition' || key === 'example';
    return (
      <label key={key} className={key === 'definition' || key === 'example' ? 'wide' : ''}>
        {label}
        {multiline ? (
          <textarea
            name={key}
            rows={2}
            maxLength={2000}
            value={draft[key]}
            disabled={!!operation}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
        ) : (
          <input
            name={key}
            value={draft[key]}
            disabled={!!operation}
            maxLength={key === 'word' ? 80 : 2000}
            aria-label={key === 'phonetic' ? label : undefined}
            aria-describedby={key === 'phonetic' ? 'phonetic-hint' : undefined}
            autoCapitalize={key === 'word' ? 'none' : undefined}
            autoCorrect={key === 'word' ? 'off' : undefined}
            spellCheck={key === 'word' ? false : undefined}
            enterKeyHint={key === 'word' ? 'next' : undefined}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
        )}
        {key === 'phonetic' && <span id="phonetic-hint" className="field-hint">{text.phoneticHint}</span>}
      </label>
    );
  }

  function card(entry: StoredEntry) {
    return (
      <article className={`entry${selecting ? ' is-selecting' : ''}`} key={entry.id}>
        {selecting && <label className="entry-selection">
          <input type="checkbox" checked={selectedWords.has(entry.id)} disabled={!!operation || !storeReady}
            onChange={event => {
              if (operationLock.current) return;
              const checked = event.target.checked;
              setSelectedWordIds(previous => checked ? [...new Set([...previous, entry.id])] : previous.filter(id => id !== entry.id));
            }} />
          <span className="sr-only">{text.selectWord(entry.word)}</span>
        </label>}
        <details className="entry-details">
          <summary>
            <span className="word-title" lang="en">{entry.word}</span>
            {entry.pos && <span className="pos">{entry.pos}</span>}
            <span className="entry-categories">{entry.categoryIds.length
              ? entry.categoryIds.map(id => categoryNames.get(id)).join(' · ') : text.uncategorized}</span>
          </summary>
          <EntryContent entry={entry} locale={locale} showPos={false} />
          <div className="entry-delete">
            <button
              className="text-button delete-word"
              type="button"
              aria-label={text.deleteWord(entry.word)}
              aria-disabled={!!operation || !storeReady}
              onClick={(event) => void remove(entry, event.currentTarget)}
            >
              <Trash2 size={16} />{text.deleteWord(entry.word)}
            </button>
          </div>
        </details>
        <button className="sound" onClick={() => speak(entry.word)} aria-label={text.speak(entry.word)}>
          <Volume2 size={18} />
        </button>
      </article>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={routeHash('words')} onClick={(event) => followRoute(event, 'words')} aria-label={text.home}>
            wordbook
          </a>
          <div className="language-switch" role="group" aria-label={text.language}>
            <button type="button" lang="zh-CN" aria-pressed={locale === 'zh-CN'} onClick={() => switchLocale('zh-CN')}>
              中文
            </button>
            <span aria-hidden="true">|</span>
            <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => switchLocale('en')}>
              EN
            </button>
          </div>
        </div>
        <nav className="page-navigation" aria-label={text.mainNavigation}>
          <a href={routeHash('words')} aria-current={route === 'words' ? 'page' : undefined}
            onClick={(event) => followRoute(event, 'words')}>{text.myWords}</a>
          <a href={routeHash('add')} aria-current={route === 'add' ? 'page' : undefined}
            onClick={(event) => followRoute(event, 'add')}>{text.addWord}</a>
        </nav>
      </header>
      <main>
        <div className="feedback">
          <div role="alert" aria-atomic="true">
            {error && <p className="message error">{formatMessage(locale, error)}</p>}
            {loadError && (
              <div className="message error">
                {formatMessage(locale, loadError)}{' '}
                <button className="text-button" disabled={loading || !!operation} onClick={() => {
                  if (!operationLock.current) void refresh();
                }}>{text.reload}</button>
              </div>
            )}
          </div>
          <div role="status" aria-atomic="true">
            {notice && <p className="message success">
              {formatMessage(locale, notice)}
              {route === 'add' && (notice.code === 'saved' || notice.code === 'imported') && <>{' '}
                <a className="text-button" href={routeHash('words')}
                  onClick={(event) => followRoute(event, 'words')}>{text.viewWords}</a>
              </>}
            </p>}
          </div>
        </div>
        {loading && <p className="loading">{text.loading}</p>}
        <div className="workspace">
          <section className="route-page add-page" hidden={route !== 'add' || practice.phase !== 'idle'} aria-labelledby="add-title">
            <div className="page-heading">
              <h1 id="add-title" ref={addHeading} tabIndex={-1}>{text.addWord}</h1>
              {(querying || draft) && <span className="composer-status">{querying ? text.querying : text.unsavedDraft}</span>}
            </div>
            <div className="composer">
              <section className="capture" aria-label={text.captureHeading}>
                <div className="capture-heading">
                  <h2 ref={captureHeading} tabIndex={-1}>{text.captureHeading}</h2>
                  <div className="dictionary-choice">
                    <label className="sr-only" htmlFor="dictionary-provider">{text.dictionary}</label>
                    <select
                      id="dictionary-provider"
                      className="provider-select"
                      value={provider}
                      title={dictionaryProviders[provider].name}
                      disabled={!!operation}
                      aria-describedby="dictionary-hint"
                      onChange={(event) => switchProvider(event.target.value)}
                    >
                      {Object.entries(dictionaryProviders).map(([id, item]) => (
                        <option value={id} key={id} title={item.name}>{item.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <p id="dictionary-hint" className="field-hint">
                  {text.dictionaryHint}{provider === 'english-dictionary' && ' ' + text.dictionaryAccentHint}
                </p>
                <form className="lookup-form" onSubmit={(event) => {
                  event.preventDefault();
                  void lookup(input).catch(() => {});
                }}>
                  <label className="sr-only" htmlFor="word">{text.englishWord}</label>
                  <input
                    id="word"
                    value={input}
                    onChange={(event) => {
                      if (queryController.current) cancelLookup();
                      setInput(event.target.value);
                    }}
                    placeholder={text.wordPlaceholder}
                    maxLength={80}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    required
                    disabled={!!operation}
                  />
                  <button className="primary" disabled={!!operation || querying || !input.trim()}>
                    {querying ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
                    {querying ? text.querying : text.autoFill}
                  </button>
                </form>
                <button
                  className="text-button manual-entry"
                  type="button"
                  disabled={!!operation || !input.trim()}
                  onClick={manualEntry}
                >
                  <PenLine size={16} /> {text.enterManually}
                </button>
                {!loading && !loadError && !words.length && (
                  <button className="text-button sample-entry" disabled={!!operation} onClick={() => openDraft(sample)}>
                    {text.trySample}
                  </button>
                )}
              </section>
              {draft && (
                <section className="draft" aria-label={text.editDraft}>
                  <div className="draft-heading">
                    <h3>{text.reviewSave}</h3>
                    <button
                      className="icon-button"
                      aria-label={text.closeDraft}
                      disabled={!!operation}
                      onClick={() => { cancelLookup(); setDraft(null); }}
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <p className="draft-tip">
                    {draft.source === '手动填写'
                      ? text.manualTip
                      : hasMyMemorySource(draft.source)
                        ? text.machineTip
                        : text.dictionaryTip}
                  </p>
                  {warnings.length > 0 && <p className="warning">{warnings.map((warning) => formatMessage(locale, warning)).join(' ')}</p>}
                  <div className="fields basic-fields">
                    {field('word', text.word)}
                    {field('translation', text.translation)}
                  </div>
                  {draft.phonetic && <p className="draft-phonetic"><Phonetic value={draft.phonetic} locale={locale} /></p>}
                  <details className="draft-details">
                    <summary>{text.moreDetails}</summary>
                    <div className="fields">
                      {field('phonetic', text.phonetic)}
                      {field('pos', text.pos)}
                      {field('definition', text.definition)}
                      {field('example', text.example)}
                    </div>
                  </details>
                  <CategoryPicker label={text.categories} categories={categories} selectedIds={draftCategories}
                    locale={locale} disabled={!!operation || !storeReady} onChange={ids => {
                      if (!operationLock.current) setDraftCategories(ids);
                    }} onCreate={name => createCategory(name, 'draft')} />
                  <div className="draft-actions">
                    <button className="primary" disabled={!!operation || !storeReady} onClick={save}>
                      {operation === 'save' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                      {text.save}
                    </button>
                  </div>
                  <Source value={draft.source} locale={locale} />
                </section>
              )}
            </div>
            <section className="import-backup" aria-labelledby="import-title">
              <h2 id="import-title" ref={importHeading} tabIndex={-1}>{text.importBackup}</h2>
              <CategoryPicker label={text.importCategories} categories={categories} selectedIds={importCategories}
                locale={locale} disabled={!!operation || !storeReady} onChange={ids => {
                  if (!operationLock.current) setImportCategories(ids);
                }} onCreate={name => createCategory(name, 'import')} />
              <p className="field-hint">{text.importCategoriesHint}</p>
              <label className="import-option">
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  disabled={!!operation || !storeReady}
                  aria-describedby="import-note"
                  onChange={(event) => {
                    if (!operationLock.current) setOverwriteExisting(event.target.checked);
                  }}
                />
                <span>{text.overwriteExisting}</span>
              </label>
              <p id="import-note" className="backup-note">{overwriteExisting ? text.importOverwriteNote : text.importNote}</p>
              <p className="backup-note">{text.importMergeHint}</p>
              <button className="secondary" disabled={!!operation || !storeReady}
                onClick={() => fileInput.current?.click()}>
                {operation === 'import' ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
                {text.importBackup}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                aria-label={text.chooseBackup}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importBackup(file, overwriteExisting, [...importCategories]);
                }}
              />
            </section>
          </section>
          <section className="route-page collection" ref={wordsPage}
            hidden={route !== 'words' || practice.phase !== 'idle'} aria-labelledby="words-title">
            <div className="collection-heading">
              <h1 id="words-title" ref={collectionHeading} tabIndex={-1}>{text.myWords} <span>{words.length}</span></h1>
              <details className="backup-tools">
                <summary>{text.backup}</summary>
                <div className="backup-panel">
                  <div className="collection-actions">
                    <button className="secondary" disabled={!!operation || !storeReady} onClick={exportBackup}>
                      {operation === 'export' ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                      {text.exportBackup}
                    </button>
                  </div>
                  <p className="backup-note">{text.storageNote}</p>
                </div>
              </details>
            </div>
            <p className="storage-note">{text.storageSummary}</p>
            <div className="category-toolbar">
              <label>
                <span className="sr-only">{text.filterCategory}</span>
                <select className="provider-select" value={categoryFilter} disabled={!storeReady} onChange={event => {
                  const value = event.target.value;
                  changeCategoryFilter(value === 'all' || value === 'uncategorized' ? value : Number(value));
                }}>
                  <option value="all">{text.allCategories}</option>
                  <option value="uncategorized">{text.uncategorized}</option>
                  <optgroup label={text.categories}>
                    {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </optgroup>
                </select>
              </label>
              <button className="secondary" ref={selectionStart} type="button" aria-pressed={selecting}
                disabled={!!operation || !storeReady || (!selecting && !results.length)} onClick={() => {
                  if (operationLock.current) return;
                  cancelSelection();
                  if (!selecting) setSelecting(true);
                }}>{text.selectWords}</button>
            </div>
            <CategoryManager categories={categories} locale={locale} disabled={!!operation || !storeReady}
              onCreate={name => createCategory(name)} onRename={renameCategory} onDelete={deleteCategory} />
            <div className="library-tools">
              <div className="library-search">
                <label className="sr-only" htmlFor="library-search">{text.searchLibrary}</label>
                <input
                  ref={librarySearch}
                  id="library-search"
                  type="search"
                  placeholder={text.librarySearchPlaceholder}
                  value={libraryQuery}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setLibraryQuery(event.target.value);
                    setLibraryPage(1);
                    cancelSelection();
                  }}
                />
                {libraryQuery && (
                  <button className="icon-button" aria-label={text.clearSearch} onClick={clearLibrarySearch}><X size={18} /></button>
                )}
              </div>
              <label className="library-sort">
                <span className="sr-only">{text.sortLibrary}</span>
                <select className="provider-select" value={librarySort} onChange={(event) => {
                  setLibrarySort(event.target.value as LibrarySort);
                  setLibraryPage(1);
                }}>
                  <option value="recent">{text.sortRecent}</option>
                  <option value="alphabetical">{text.sortAlphabetical}</option>
                </select>
              </label>
              <p className="library-results" role="status" aria-atomic="true">
                {!loading && !loadError && text.libraryResults(page.start, page.end, results.length, words.length)}
              </p>
            </div>
            {words.length > 0 && (
              <div className="practice-launch">
                <p className="practice-ready">{text.practiceReady(eligible.length)}</p>
                <button
                  ref={practiceStart}
                  className="primary"
                  disabled={loading || !storeReady || !!operation || !eligible.length}
                  aria-describedby="practice-scope"
                  onClick={startPractice}
                >
                  {text.startPractice}
                </button>
                <p className="field-hint" id="practice-scope">{text.practiceScope}</p>
                {!loading && !loadError && results.length > 0 && !eligible.length && <p className="field-hint">{text.practiceUnavailable}</p>}
              </div>
            )}
            {selecting && <section className="batch-tools" aria-label={text.batchCategories}>
              <p role="status" aria-atomic="true">{text.selectedWords(selectedWordIds.length)}
                {outsideSelection > 0 && <span className="category-summary">{text.selectedOutsideResults(outsideSelection)}</span>}
              </p>
              <div className="selection-actions">
                <button className="secondary" type="button" disabled={!!operation || !storeReady || !page.entries.length}
                  onClick={() => selectEntries(page.entries)}>{text.selectPage}</button>
                <button className="secondary" type="button" disabled={!!operation || !storeReady || !results.length}
                  onClick={() => selectEntries(results)}>{text.selectResults}</button>
                <button className="text-button" type="button" disabled={!!operation} onClick={() => {
                  cancelSelection();
                  selectionStart.current?.focus({ preventScroll: true });
                }}>{text.cancelSelection}</button>
              </div>
              <label className="batch-action">
                <span>{text.categoryAction}</span>
                <select className="provider-select" value={categoryAction} disabled={!!operation || !storeReady}
                  onChange={event => { if (!operationLock.current) setCategoryAction(event.target.value as CategoryChange['mode']); }}>
                  <option value="add">{text.addCategories}</option>
                  <option value="remove">{text.removeCategories}</option>
                  <option value="replace">{text.replaceCategories}</option>
                  <option value="clear">{text.clearCategories}</option>
                </select>
              </label>
              {categoryAction !== 'clear' && <CategoryPicker label={text.targetCategories} categories={categories}
                selectedIds={bulkCategories} locale={locale} disabled={!!operation || !storeReady} onChange={ids => {
                  if (!operationLock.current) setBulkCategories(ids);
                }} onCreate={name => createCategory(name, 'bulk')} />}
              {(categoryAction === 'replace' || categoryAction === 'clear') && <p className="field-hint">{text.replaceCategoriesHint}</p>}
              <button className="primary" type="button"
                aria-disabled={!!operation || !storeReady || !selectedWordIds.length || (categoryAction !== 'clear' && !bulkCategories.length)}
                onClick={event => void applyCategories(event.currentTarget)}>{text.applyCategories}</button>
            </section>}
            <div className="entry-list">{page.entries.map(card)}</div>
            {page.pageCount > 1 && (
              <nav className="library-pagination" aria-label={text.libraryPagination}>
                <button className="secondary" disabled={page.page === 1} onClick={() => changeLibraryPage(page.page - 1)}>
                  {text.previousPage}
                </button>
                <p>{text.libraryPage(page.page, page.pageCount)}</p>
                <button className="secondary" disabled={page.page === page.pageCount} onClick={() => changeLibraryPage(page.page + 1)}>
                  {text.nextPage}
                </button>
              </nav>
            )}
            {!loading && !loadError && !results.length && (words.length > 0 || categoryFilter !== 'all' || libraryQuery.trim()) && (
              <div className="empty-state">
                <p>{libraryQuery.trim() || categoryFilter === 'all' ? text.noMatches
                  : categoryFilter === 'uncategorized' ? text.emptyUncategorized : text.emptyCategory}</p>
                <button className="text-button" onClick={clearFilters}>{text.clearFilters}</button>
              </div>
            )}
            {!loading && !loadError && !words.length && categoryFilter === 'all' && !libraryQuery.trim() && (
              <div className="empty-state">
                <p>{text.emptyNotebook}</p>
                <div className="empty-actions">
                  <a className="primary" href={routeHash('add')}
                    onClick={(event) => followRoute(event, 'add')}>{text.addWord}</a>
                  <a className="secondary" href={routeHash('add')}
                    onClick={(event) => followRoute(event, 'add', 'import')}>{text.importBackup}</a>
                </div>
              </div>
            )}
          </section>
        </div>
        {route === 'words' && practice.phase !== 'idle' && (
          <PracticePanel
            state={practice}
            locale={locale}
            dispatch={dispatchPractice}
            onSpeak={speak}
            onExit={() => navigate('words', 'practice-return')}
          />
        )}
      </main>
    </div>
  );
}
