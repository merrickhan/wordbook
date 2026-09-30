// Keep the notebook in browser storage; only autofill requests external dictionaries and translation.
import { useState, useEffect, useRef } from 'react';
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
import { DICTIONARY_LICENSE_URL, hasMyMemorySource, lookup as queryWord, wiktionaryUrl } from './vocabulary';
import { createWordStore, databaseName } from './storage';
import { MAX_BACKUP_BYTES, parseBackup, serializeBackup } from './backup';
import { errorMessage, MessageError, type Message } from './messages';
import { ui, formatMessage, sourceLabel, formatDate, readLocale, writeLocale, type Locale } from './i18n';
import { dictionaryProviders, isDictionaryProvider, readDictionaryProvider, writeDictionaryProvider, removeLegacyTranslationPreferences, type DictionaryProvider } from './dictionary-providers';
import { hasAccentLabels } from './phonetics';

const dbNamespace = databaseName(window.location.href);
const store = createWordStore({ name: dbNamespace });
type Operation = '' | 'save' | 'delete' | 'import' | 'export';

function Phonetic({ value, locale }: { value: string; locale: Locale }) {
  const labeled = hasAccentLabels(value);
  return (
    <span className="phonetic" title={labeled ? ui[locale].accentLabels : undefined}>
      {value}{!labeled && <span className="accent-note"> · {ui[locale].unknownAccent}</span>}
    </span>
  );
}

function Source({ value, locale }: { value: string; locale: Locale }) {
  const provider = Object.values(dictionaryProviders).find((item) => value.startsWith(item.name + ' | '));
  if (!provider)
    return <span className="source">{ui[locale].source}{sourceLabel(locale, value)}</span>;
  return (
    <span className="source">
      {ui[locale].source}{value.split(' | ').map((part, index) => {
        let href = '';
        let label = sourceLabel(locale, part);
        if (part === provider.name) href = provider.homepage;
        if (part.startsWith('Wiktionary: ')) {
          href = wiktionaryUrl(part.slice('Wiktionary: '.length));
          if (href) label = ui[locale].wiktionaryArticle;
        }
        if (part === 'CC BY-SA 4.0: ' + DICTIONARY_LICENSE_URL) {
          href = DICTIONARY_LICENSE_URL;
          label = 'CC BY-SA 4.0';
        }
        return (
          <span key={index}>
            {index > 0 && ' · '}
            {href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : label}
          </span>
        );
      })}
    </span>
  );
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>(() => readLocale(dbNamespace));
  const localeRef = useRef(locale);
  const [provider, setProvider] = useState<DictionaryProvider>(() => readDictionaryProvider(dbNamespace));
  const providerRef = useRef(provider);
  const text = ui[locale];
  const [words, setWords] = useState<StoredEntry[]>([]),
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
  const active = useRef(false);
  const ready = useRef(false);
  const operationLock = useRef<Operation>('');
  const listRequest = useRef(0);
  const queryRequest = useRef(0);
  const queryController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const collectionHeading = useRef<HTMLHeadingElement>(null);

  function switchLocale(next: Locale) {
    localeRef.current = next;
    setLocale(next);
    writeLocale(dbNamespace, next);
  }

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = ui[locale].pageTitle;
    document.querySelector('meta[name="description"]')?.setAttribute('content', ui[locale].pageDescription);
  }, [locale]);

  async function refresh(silent = false) {
    const request = ++listRequest.current;
    if (!silent) setLoading(true);
    try {
      const entries = await store.list();
      if (!active.current || request !== listRequest.current) return;
      setWords(entries);
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
    window.addEventListener('focus', onFocus);
    return () => {
      active.current = false;
      listRequest.current++;
      queryRequest.current++;
      queryController.current?.abort();
      window.removeEventListener('focus', onFocus);
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
  function beginOperation(next: Operation) {
    if (operationLock.current) return false;
    if (!ready.current) {
      setError({ code: 'storeNotReady' });
      return false;
    }
    operationLock.current = next;
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
      const entry = await store.save(draft);
      if (!active.current) return;
      listRequest.current++;
      setWords((previous) => [entry, ...previous.filter((item) => item.id !== entry.id)]);
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
    if (!beginOperation('delete')) return;
    try {
      if (!window.confirm(ui[localeRef.current].confirmDelete(entry.word))) return;
      listRequest.current++;
      setLoading(false);
      await store.remove(entry.id);
      if (!active.current) return;
      if (document.activeElement === trigger && document.hasFocus()) {
        const article = trigger.closest('article');
        const next = article?.nextElementSibling?.querySelector<HTMLButtonElement>('.sound')
          ?? article?.previousElementSibling?.querySelector<HTMLButtonElement>('.sound')
          ?? collectionHeading.current;
        next?.focus({ preventScroll: true });
      }
      setWords((previous) => previous.filter((item) => item.id !== entry.id));
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
      const backup = serializeBackup(await store.list());
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

  async function importBackup(file: File) {
    if (!beginOperation('import')) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new MessageError({ code: 'importFileTooLarge' });
      const entries = parseBackup(await file.text());
      const result = await store.importEntries(entries);
      if (!active.current) return;
      setNotice({ code: 'imported', params: { imported: result.imported, skipped: result.skipped } });
      await refresh(true);
    } catch (error) {
      if (active.current) setError({ code: 'importFailed', params: { reason: errorMessage(error) } });
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
      <article className="entry" key={entry.id}>
        <div className={'word-pair' + (entry.translation ? ' has-translation' : '')}>
          <div className="word-line">
            <h3>{entry.word}</h3>
            <button className="sound" onClick={() => speak(entry.word)} aria-label={text.speak(entry.word)}>
              <Volume2 size={18} />
            </button>
            <button
              className="icon-button delete-word"
              type="button"
              aria-label={text.deleteWord(entry.word)}
              title={text.deleteWord(entry.word)}
              aria-disabled={!!operation || !storeReady}
              onClick={(event) => void remove(entry, event.currentTarget)}
            >
              <Trash2 size={18} />
            </button>
          </div>
          {(entry.phonetic || entry.pos) && (
            <div className="word-meta">
              {entry.phonetic && <Phonetic value={entry.phonetic} locale={locale} />}
              {entry.pos && <span className="pos">{entry.pos}</span>}
            </div>
          )}
          <p className="meaning"><span>{entry.translation || text.translationPlaceholder}</span></p>
        </div>
        <details className="entry-details">
          <summary>{text.entryDetails}</summary>
          {(entry.definition || entry.example) && (
            <div className="entry-content">
              {entry.definition && <p className="definition">{entry.definition}</p>}
              {entry.example && (
                <div className="example">
                  <span>{text.example}</span>
                  <p>{entry.example}</p>
                </div>
              )}
            </div>
          )}
          <footer>
            <time dateTime={entry.created}>{formatDate(locale, entry.created)}</time>
            {entry.source && <Source value={entry.source} locale={locale} />}
          </footer>
        </details>
      </article>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={import.meta.env.BASE_URL} aria-label={text.home}>
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
      </header>
      <main>
        <div className="composer">
          <section className="capture" aria-label={text.addWord}>
            <div className="capture-heading">
              <h1>{text.captureHeading}</h1>
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
          </section>
          <div className="feedback">
            <div role="alert" aria-atomic="true">
              {error && <p className="message error">{formatMessage(locale, error)}</p>}
            </div>
            <div role="status" aria-atomic="true">
              {notice && <p className="message success">{formatMessage(locale, notice)}</p>}
            </div>
          </div>
          {draft && (
            <section className="draft" aria-label={text.editDraft}>
              <div className="draft-heading">
                <h2>{text.reviewSave}</h2>
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
        <section className="collection" aria-label={text.myWords}>
          <div className="collection-heading">
            <h2 ref={collectionHeading} tabIndex={-1}>{text.myWords} <span>{words.length}</span></h2>
            <details className="backup-tools">
              <summary>{text.backup}</summary>
              <div className="backup-panel">
                <div className="collection-actions">
                  <button
                    className="secondary"
                    disabled={!!operation || !storeReady}
                    onClick={() => fileInput.current?.click()}
                  >
                    {operation === 'import' ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
                    {text.importBackup}
                  </button>
                  <button className="secondary" disabled={!!operation || !storeReady} onClick={exportBackup}>
                    {operation === 'export' ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                    {text.exportBackup}
                  </button>
                </div>
                <p className="backup-note">{text.storageNote}</p>
                <p className="backup-note">{text.importNote}</p>
              </div>
            </details>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label={text.chooseBackup}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importBackup(file);
            }}
          />
          <p className="storage-note">{text.storageSummary}</p>
          {loading && <p className="loading">{text.loading}</p>}
          {loadError && (
            <div className="message error" role="alert">
              {formatMessage(locale, loadError)} <button className="text-button" onClick={() => void refresh()}>{text.reload}</button>
            </div>
          )}
          {words.map(card)}
          {!loading && !loadError && !words.length && (
            <div className="empty-state">
              <p>{text.emptyNotebook}</p>
              <button className="text-button" disabled={!!operation} onClick={() => openDraft(sample)}>
                {text.trySample}
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
