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

Wordbook selects an English sense, its example and available Chinese translations;
text is trimmed and may be shortened. Confirmed FreeDictionaryAPI.com IPA accents are
labeled US / UK; segments that do not fit the 2,000-character total are omitted whole
with a warning, never partly truncated. EnglishDictionaryAPI.com's single IPA has no
accent metadata; Wordbook does not infer accents from audio URLs or load dictionary
recordings. Users may edit excerpts before saving. Each adopted dictionary entry retains
its provider, original Wiktionary article URL, license and modification notice in the
existing `source` field, including in JSON backups. Editing the word or switching
providers does not rewrite that source.
The application displays links to the provider, original article and license.
Redistributed dictionary content must retain the applicable attribution, license and
modification notices; adaptations must meet the license's ShareAlike requirements.
This data license is separate from the software dependency licenses below.

For network lookups, only the selected dictionary and the independently selected
Chinese-completion service, MyMemory (the default) or Baidu, receive the query. They
are requested in parallel; Baidu is not requested without saved credentials. Chinese
from the selected dictionary sense takes priority, with machine translation filling
missing Chinese only. There are no automatic retries or fallbacks to an unselected
dictionary or translation service. The exact source label `MyMemory（机器翻译）` or
`Baidu（机器翻译）` is recorded only when that translation is adopted. Historical entries
are not relabeled when either selection changes.

# Machine translation: MyMemory / Baidu

Machine translations are separate from the dictionary excerpts described above;
Wordbook does not apply Wiktionary's CC BY-SA 4.0 license to MyMemory or Baidu output.
Baidu provides Chinese translation only, not dictionary IPA, parts of speech,
English definitions, examples, or per-entry dictionary license metadata. Baidu
translations exceeding 2,000 characters are rejected whole, not truncated for use.

Baidu use is governed by the service's current terms and account conditions. Consult
its official [product documentation](https://fanyi-api.baidu.com/product/113) and
[API documentation](https://fanyi-api.baidu.com/doc/23) for current requirements,
pricing and quotas; this project does not promise a fixed price or allowance.
The official guidance warns against leaking credentials or entering them into
third-party software. Wordbook is a third-party frontend, not an official Baidu client;
enter an APPID and key only in a deployment you trust and only if you accept this
boundary. Multiple APPIDs used from the same IP on the same day may trigger error
`58003`. Requests may incur charges even when the translation is not adopted or the
local lookup is cancelled. Cancellation cannot retract an already accepted request
or guarantee that it is unbilled.

Users supply their own APPID and key in the frontend. The selected translator and
credentials are stored in deployment-namespaced `localStorage`, outside entries,
IndexedDB, JSON backups and application tool output. Credentials are plaintext;
a password field masks display, not storage. Same-origin pages and scripts,
browser extensions with appropriate access, and other users of the browser profile
may access them. Deployment-directory namespacing is not a security boundary.
Saving requires both fields to pass local validation and persistence before the
new configuration becomes active; it makes no request and does not verify the
account with Baidu. The password input is cleared after a successful save.

The fixed HTTPS endpoint is `https://fanyi-api.baidu.com/api/trans/vip/translate`.
Wordbook computes Baidu's required MD5 signature locally with `@noble/hashes` and
loads JSONP only inside a temporary iframe with `sandbox="allow-scripts"`, without
`allow-same-origin`. The signed URL contains the query (`q`), APPID (`appid`), `salt`
and `sign`, but not the raw key; it can appear in network tools or service logs.
Unlike dictionary and MyMemory fetches using `credentials: 'omit'`, JSONP may send
Baidu cookies permitted by browser policy. The sandbox prevents the remote script
from directly reading the parent DOM and local storage, but does not authenticate
upstream content or impose a CPU quota. MD5 is required by the API protocol and is
not used to encrypt stored credentials.

The live capability probe sent only a callback parameter, with no query or
credentials, and received the wrapped authorization error `52003` in a sandboxed
Chromium iframe. This was not a successful authenticated translation and did not
verify iPhone Safari support. Mock tests and checklists are not evidence of live
account, quota or device compatibility.

# @noble/hashes 2.4.0

Used for local MD5 signing required by Baidu's translation protocol. The following
notice is reproduced from the installed package's `LICENSE`.

The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

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
