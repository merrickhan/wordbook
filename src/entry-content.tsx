import type { ReactNode } from 'react';
import type { StoredEntry } from './entry';
import { dictionaryProviders } from './dictionary-providers';
import { ui, sourceLabel, formatDate, type Locale } from './i18n';
import { hasAccentLabels } from './phonetics';
import { DICTIONARY_LICENSE_URL, wiktionaryUrl } from './vocabulary';

export function Phonetic({ value, locale }: { value: string; locale: Locale }) {
  const labeled = hasAccentLabels(value);
  return (
    <span className="phonetic" title={labeled ? ui[locale].accentLabels : undefined}>
      {value}{!labeled && <span className="accent-note"> · {ui[locale].unknownAccent}</span>}
    </span>
  );
}

export function Source({ value, locale }: { value: string; locale: Locale }) {
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

export function EntryContent({ entry, locale, showPos = true, beforeMetadata }: {
  entry: Readonly<StoredEntry>;
  locale: Locale;
  showPos?: boolean;
  beforeMetadata?: ReactNode;
}) {
  const text = ui[locale];
  return (
    <div className="entry-content">
      <div className={'word-pair' + (entry.translation ? ' has-translation' : '')}>
        {(entry.phonetic || (showPos && entry.pos)) && (
          <div className="word-meta">
            {entry.phonetic && <Phonetic value={entry.phonetic} locale={locale} />}
            {showPos && entry.pos && <span className="pos">{entry.pos}</span>}
          </div>
        )}
        <p className="meaning"><span>{entry.translation || text.translationPlaceholder}</span></p>
      </div>
      {entry.definition && <p className="definition">{entry.definition}</p>}
      {entry.example && (
        <div className="example">
          <span>{text.example}</span>
          <p>{entry.example}</p>
        </div>
      )}
      {beforeMetadata}
      <footer>
        <time dateTime={entry.created}>{formatDate(locale, entry.created)}</time>
        {entry.source && <Source value={entry.source} locale={locale} />}
      </footer>
    </div>
  );
}
