# Vendored: qrcode-generator

`qrcode.mjs` and `qrcode.d.mts` are copied verbatim from
[`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) 2.0.4
(Kazuhiko Arase, MIT). The upstream distribution is `dist/qrcode.mjs`; its
SHA-256 is `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`.

It is vendored rather than depended on because it is used at exactly one point —
encoding the login URL into the QR the panel shows — and a login that cannot be
scanned is the failure this whole screen exists to avoid. Keeping the encoder in
the tree means the published package has no runtime dependency to install, and
the code that renders the login cannot drift when a registry resolves a
different version. `dsh-wechat` vendors the same library for the same reason.

The iLink `qrcode_img_content` value is an HTML page that renders the QR with
JavaScript, not an image: `<img src="...">` shows nothing. The URL therefore has
to be encoded here.

## The one thing to remember when editing this file

`qrcode.mjs` is the **default** build, whose `stringToBytes` truncates each
UTF-16 code unit to one byte (`c & 0xff`). That is only correct for Latin-1
text. The sibling `qrcode_UTF8.mjs` build overrides it with a real UTF-8
encoder. Callers must therefore install a UTF-8 encoder before `addData`; see
`src/wechat/qr.ts`, which does it, and whose tests pin the difference by
asserting the module count a multi-byte URL requires.
