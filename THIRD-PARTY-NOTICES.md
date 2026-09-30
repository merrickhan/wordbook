# Dictionary content: FreeDictionaryAPI.com / EnglishDictionaryAPI.com / Wiktionary

Dictionary excerpts are provided by the selected service,
[FreeDictionaryAPI.com](https://freedictionaryapi.com/) (the default) or
[EnglishDictionaryAPI.com](https://englishdictionaryapi.com/), and originate from
[Wiktionary contributors](https://en.wiktionary.org/) under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
The [legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en) governs use of this content.

FreeDictionaryAPI.com supplies article and license metadata, which Wordbook validates.
EnglishDictionaryAPI.com's official site documents English Wiktionary content under
CC BY-SA 4.0 and a 2026-06-01 data dump; its response model has no per-entry source or
license fields. When returned content matches the original query, Wordbook constructs
and validates a safe HTTPS English Wiktionary article URL from that query and retains
it with the documented license. The article URL is not supplied by this API.

Wordbook selects an English sense, its example, and available Chinese translations;
text is trimmed and may be shortened. Confirmed FreeDictionaryAPI.com IPA accents are
labeled US / UK; segments that do not fit the 2,000-character total are omitted whole
with a warning, never partly truncated. EnglishDictionaryAPI.com's single IPA has no
accent metadata; Wordbook does not infer accents from audio URLs or load dictionary
recordings. Users may edit excerpts before saving. Each adopted dictionary entry retains
its service name, original Wiktionary article URL, license, and modification notice in
the existing `source` field, including in version 1 JSON backups. Editing the word,
switching dictionaries, or changing interface language does not rewrite that source.
The application displays links to the service, original article, and license. Draft
attribution remains directly visible; saved entries expose full attribution through
**Details & source**. Collapsing the details does not remove attribution from the entry
or its backup.

Redistributed dictionary content must retain applicable attribution, license information,
and modification notices; adaptations must meet the license's ShareAlike requirements.
This data license is separate from the software dependency licenses below and does not
cover MyMemory translations.

# Chinese completion: MyMemory

[MyMemory](https://mymemory.translated.net/) is the fixed Chinese-completion service.
For network lookups, only the selected dictionary and MyMemory receive the query,
in parallel. Chinese from the selected dictionary sense takes priority; MyMemory fills
missing Chinese only. It does not supply Wordbook's dictionary IPA, parts of speech,
English definitions, examples, or per-entry dictionary license metadata. There are no
automatic retries or requests to another dictionary or translation service. If one
branch fails, usable content from the other is retained for an editable draft.

The exact raw source label `MyMemory（机器翻译）` is recorded only when its translation
is adopted. Wordbook preserves recorded source strings in saved entries and JSON
backups rather than relabeling them when a preference changes. Unknown historical
source values remain opaque text. MyMemory output is separate from dictionary excerpts;
Wordbook does not grant a CC BY-SA 4.0 license to it merely by displaying or backing it up.
Consult the service's current terms, [API documentation](https://mymemory.translated.net/doc/spec.php),
and [usage limits](https://mymemory.translated.net/doc/usagelimits.php) before using the
service or reusing its output. This project does not promise a fixed quota, continued
availability, or unrestricted reuse rights.

Both fetches use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, but the
services still receive the query. MyMemory is requested even when dictionary Chinese
ultimately takes priority. Each request has its own 30-second timeout. Cancellation
stops local waiting and acceptance of results; it cannot retract a request already
received by an upstream service. Mock tests and browser emulation are not evidence of
live-service availability or real iPhone Safari compatibility.

For usage and data boundaries, see [README-ZH.md](README-ZH.md); implementation and
validation guidance is in [MAINTENANCE-ZH.md](MAINTENANCE-ZH.md). Vite emits this notice
file into the build output as `THIRD-PARTY-NOTICES.md`.

# react

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


# react-dom

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


# lucide-react

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
