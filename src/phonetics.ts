type Pronunciation = { text: unknown; tags?: unknown };

const accents = [
  { label: 'US', tags: ['us', 'general american'] },
  { label: 'UK', tags: ['uk', 'received pronunciation'] },
];

export function formatPhonetics(pronunciations: readonly Pronunciation[]): { phonetic: string; omitted: boolean } {
  const candidates = pronunciations.map((value) => ({
    text: typeof value.text === 'string' ? value.text.trim() : '',
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().toLowerCase())
      : [],
  })).filter((value) => value.text);
  const segments: string[] = [];
  for (const accent of accents) {
    const candidate = candidates.find((value) => value.tags.some((tag) => accent.tags.includes(tag)));
    if (candidate) segments.push(accent.label + ' ' + candidate.text);
  }
  if (!segments.length && candidates[0]) segments.push(candidates[0].text);

  let phonetic = '';
  let omitted = false;
  for (const segment of segments) {
    const combined = phonetic ? phonetic + ' · ' + segment : segment;
    // Keep each label and IPA together; never truncate a transcription to fit.
    if (combined.length <= 2000) phonetic = combined;
    else omitted = true;
  }
  return { phonetic, omitted };
}

export function hasAccentLabels(value: string): boolean {
  const parts = value.trim().split(/\s*·\s*/);
  const labels = parts.map((part) => /^(US|UK) (\S(?:[\s\S]*\S)?)$/.exec(part)?.[1]);
  return parts.length <= 2 && labels.every(Boolean) && new Set(labels).size === parts.length;
}
