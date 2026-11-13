# Third-party notices

## Web Scrobbler

Parts of `src/main/title-parser.ts` and `src/main/youtube.ts` are ported from
[Web Scrobbler](https://github.com/web-scrobbler/web-scrobbler)
(`src/core/content/util.ts` and `src/connectors/youtube.ts`): the title separators,
the YouTube video title parser, the "Provided to YouTube by" description parser and the
"- Topic" channel suffix. The scrobble rules (skip tracks under 30 seconds, scrobble at
half the length or 4 minutes) follow Web Scrobbler's behaviour.

```
The MIT License (MIT)
Copyright © 2010-2023 David Šabata & Web Scrobbler Team

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
```
