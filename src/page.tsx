// 主页面直接访问浏览器词本；仅自动补全会请求外部词典。
import { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  Plus,
  ArrowUpRight,
  Check,
  LoaderCircle,
  PenLine,
  Volume2,
  Download,
  Upload,
  X,
} from 'lucide-react';
import { createEntry, sample, validWord, type Entry, type StoredEntry } from './entry';
import { DICTIONARY_LICENSE_URL, lookup as queryWord, wiktionaryUrl } from './vocabulary';
import { createWordStore, databaseName } from './storage';
import { MAX_BACKUP_BYTES, parseBackup, serializeBackup } from './backup';
import { errorMessage, MessageError, type Message } from './messages';
import { ui, formatMessage, sourceLabel, formatDate, readLocale, writeLocale, type Locale } from './i18n';

const dbNamespace = databaseName(window.location.href);
const store = createWordStore({ name: dbNamespace });
type Operation = '' | 'save' | 'import' | 'export';

function Source({ value, locale }: { value: string; locale: Locale }) {
  if (!value.startsWith('FreeDictionaryAPI.com | '))
    return <span className="source">{ui[locale].source}{sourceLabel(locale, value)}</span>;
  return (
    <span className="source">
      {ui[locale].source}{value.split(' | ').map((part, index) => {
        let href = '';
        let label = sourceLabel(locale, part);
        if (part === 'FreeDictionaryAPI.com') href = 'https://freedictionaryapi.com/';
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

  async function refresh() {
    const request = ++listRequest.current;
    setLoading(true);
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
    void refresh();
    const onFocus = () => {
      if (!operationLock.current) void refresh();
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

  async function lookup(word: string) {
    if (operationLock.current) throw new MessageError({ code: 'operationBusy' });
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
      const result = await queryWord(word, undefined, controller.signal);
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

  // ref 在同一事件轮次立即上锁，避免仅依靠 disabled 时的快速重复提交。
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
      // refresh 自行报告读取失败，不把已提交的保存误报为失败。
      await refresh();
    } catch (error) {
      if (active.current) setError(errorMessage(error));
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
      await refresh();
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
            title: '查询单词并打开编辑',
            description: '查询英文单词的音标、中文释义和例句，在页面打开待确认条目，不保存。',
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
    window.speechSynthesis.speak(utterance);
  }

  function card(entry: Entry & { id?: number; created?: string }, index: number, isSample = false) {
    return (
      <article className="entry" key={entry.id || 'sample'}>
        <div className="entry-number">{String(index + 1).padStart(2, '0')}</div>
        <div className="entry-body">
          <div className="word-line">
            <h2>{entry.word}</h2>
            <button className="sound" onClick={() => speak(entry.word)} aria-label={text.speak(entry.word)}>
              <Volume2 size={18} />
            </button>
            <span className="entry-tag">{isSample ? text.sampleTag : text.savedTag}</span>
          </div>
          <div className="phonetic-line">
            <span className="phonetic">{entry.phonetic || text.phoneticPlaceholder}</span>
            <span className="meaning">{entry.translation || text.translationPlaceholder}</span>
          </div>
          <p className="definition">
            <span className="pos">{entry.pos || text.posPlaceholder}</span>
            {entry.definition || text.definitionPlaceholder}
          </p>
          <div className="example">
            <span>EXAMPLE</span>
            <p>{entry.example || text.examplePlaceholder}</p>
          </div>
          <footer>
            {isSample
              ? text.sampleFooter
              : entry.created
                ? formatDate(locale, entry.created)
                : ''}
            {!isSample && <Source value={entry.source} locale={locale} />}
            {isSample && (
              <button disabled={!!operation} onClick={() => openDraft(sample)}>
                {text.addSample} <Plus size={14} />
              </button>
            )}
          </footer>
        </div>
      </article>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label={text.home}>
          <span className="brand-icon"><BookOpen size={22} /></span>
          wordbook
          <span className="brand-divider" />
          <span className="brand-cn">{text.brandSubtitle}</span>
        </a>
        <div className="topbar-actions">
          <span className="personal">MY PERSONAL NOTEBOOK</span>
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
      <div className="workspace">
        <aside className="rail">
          <span className="rail-label">YOUR COLLECTION</span>
          <div className="nav-item">
            <BookOpen size={19} />
            <span>{text.notebook}</span>
            <b>{words.length}</b>
          </div>
          <div className="rail-note">
            <span className="small-rule" />
            <p>One word at a time.</p>
            <span>{text.railNote}</span>
          </div>
          <div className="rail-bottom">ENGLISH → 中文 <span>01</span></div>
        </aside>
        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORDS WORTH KEEPING</p>
              <h1>Vocabulary Notebook<span>.</span></h1>
              <p className="intro">{text.intro}</p>
            </div>
            <span className="notebook-mark">Aa<span>EN / ZH</span></span>
          </div>
          <section className="capture" aria-label={text.addWord}>
            <div className="capture-heading">
              <span className="plus-mark"><Plus size={18} /></span>
              <h2>{text.captureHeading}</h2>
            </div>
            <form onSubmit={(event) => {
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
                required
                disabled={!!operation}
              />
              <button className="primary" disabled={!!operation || querying || !input.trim()}>
                {querying ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                {querying ? text.querying : text.autoFill}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={!!operation || !input.trim()}
                onClick={manualEntry}
              >
                <PenLine size={16} /> {text.enterManually}
              </button>
            </form>
            <div className="capture-hint">
              <span><Check size={14} /> {text.phonetic}</span>
              <span><Check size={14} /> {text.translation}</span>
              <span><Check size={14} /> {text.posDefinition}</span>
              <span><Check size={14} /> {text.example}</span>
            </div>
          </section>
          <div aria-live="polite" aria-atomic="true">
            {error && <p className="message error" role="alert">{formatMessage(locale, error)}</p>}
            {notice && <p className="message success">{formatMessage(locale, notice)}</p>}
          </div>
          {draft && (
            <section className="draft" aria-label={text.editDraft}>
              <div className="draft-heading">
                <h2><PenLine size={18} /> {text.reviewSave}</h2>
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
                  : draft.source.includes('MyMemory（机器翻译）')
                    ? text.machineTip
                    : text.dictionaryTip}
              </p>
              {warnings.length > 0 && <p className="warning">{warnings.map((warning) => formatMessage(locale, warning)).join(' ')}</p>}
              <div className="fields">
                {([
                  ['word', text.word],
                  ['phonetic', text.phonetic],
                  ['translation', text.translation],
                  ['pos', text.pos],
                  ['definition', text.definition],
                  ['example', text.example],
                ] as const).map(([key, label]) => (
                  <label key={key} className={key === 'definition' || key === 'example' ? 'wide' : ''}>
                    {label}
                    {key === 'definition' || key === 'example' ? (
                      <textarea
                        value={draft[key]}
                        disabled={!!operation}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    ) : (
                      <input
                        value={draft[key]}
                        disabled={!!operation}
                        maxLength={key === 'word' ? 80 : 2000}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      />
                    )}
                  </label>
                ))}
              </div>
              <div className="draft-actions">
                <Source value={draft.source} locale={locale} />
                <button className="primary" disabled={!!operation || !storeReady} onClick={save}>
                  {operation === 'save' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                  {text.save}
                </button>
              </div>
            </section>
          )}
          <section className="collection" aria-label={text.myWords}>
            <div className="collection-heading">
              <h2>{text.myWords} <span>{words.length}</span></h2>
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
              </div>
            </div>
            <p className="storage-note">
              {text.storageNote}
              <span>{text.importNote}</span>
            </p>
            {loading ? (
              <p className="loading">{text.loading}</p>
            ) : loadError ? (
              <div className="message error" role="alert">
                {formatMessage(locale, loadError)} <button className="text-button" onClick={refresh}>{text.reload}</button>
              </div>
            ) : words.length ? (
              words.map((entry, index) => card(entry, index))
            ) : (
              card(sample, 0, true)
            )}
          </section>
          <div className="page-footer">
            <span>YOUR WORDS, YOUR WORLD.</span>
            <span>
              {text.lookupProviders}
              <a href="https://freedictionaryapi.com/" target="_blank" rel="noreferrer">
                FreeDictionaryAPI.com <ArrowUpRight size={12} />
              </a>{' '}·{' '}
              <a href="https://mymemory.translated.net/" target="_blank" rel="noreferrer">
                MyMemory <ArrowUpRight size={12} />
              </a>
            </span>
          </div>
        </main>
      </div>
    </div>
  );
}
