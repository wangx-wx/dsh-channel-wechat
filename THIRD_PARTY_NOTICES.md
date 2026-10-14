# Third-Party Notices

This project is distributed under the MIT License (see `LICENSE`). It includes
material from the projects below, reproduced with their notices.

---

## openclaw-weixin

Portions of this project are adapted from `@tencent-weixin/openclaw-weixin`
(<https://github.com/Tencent/openclaw-weixin>).

The following files contain code adapted from it:

| File | Adapted from |
|---|---|
| `src/wechat/cdn.ts` | `src/cdn/cdn-url.ts` |
| `src/wechat/crypto.ts` | `src/cdn/aes-ecb.ts`, `src/cdn/pic-decrypt.ts` |
| `src/wechat/media-download.ts` | `src/cdn/pic-decrypt.ts` |
| `src/wechat/cdn-upload.ts` | `src/cdn/cdn-upload.ts` |
| `src/wechat/api.ts` | `src/api/api.ts` (error classification) |
| `src/wechat/login-machine.ts` | `src/auth/login-qr.ts` |
| `src/wechat/login-runner.ts` | `src/auth/login-qr.ts` |
| `src/wechat/types.ts` | `docs/protocol_zh_CN.md`'s type tables |

The protocol document `docs/protocol/protocol_zh_CN.md` is reproduced from the
same project.

Its license, in full:

```
Tencent is pleased to support the open source community by making openclaw-weixin available.

Copyright (C) 2026 Tencent.  All rights reserved.

openclaw-weixin is licensed under the MIT.


Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## qrcode-generator

`src/vendor/qrcode.mjs` and `src/vendor/qrcode.d.mts` are copied verbatim from
`qrcode-generator` 2.0.4 (<https://github.com/kazuhikoarase/qrcode-generator>).

```
Copyright (c) 2009, 2016 Kazuhiko Arase

Licensed under the MIT license:
http://www.opensource.org/licenses/mit-license.php

The word 'QR Code' is registered trademark of DENSO WAVE INCORPORATED
http://www.denso-wave.com/qrcode/faqpatent-e.html
```
