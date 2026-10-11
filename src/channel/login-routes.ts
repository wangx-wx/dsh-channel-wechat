/**
 * The login routes the panel talks to.
 *
 * Each is a plain function from a request to a response, so the page and its API
 * are testable without a server. The page is self-contained HTML: it is served
 * to a browser with no build step and no client plugin, so a `<script src>` would
 * point at a bundle this package does not ship.
 *
 * These are mounted under `/api` by the composition row, which is what puts them
 * behind the harness's own process-token and browser-cookie fence. Nothing here
 * authenticates a request, and nothing here should: a route that re-implemented
 * the check would be one more place for it to be wrong.
 *
 * @module dsh-channel-wechat/channel/login-routes
 */

import type { LoginSession } from './login-session.ts'
import { renderQrSvg } from '../wechat/qr.ts'

/** What the routes read and drive. */
export interface LoginRoutesOptions {
  /** The attempt the page watches. */
  session: LoginSession
}

/** The route set, shaped for `ctx.connection.fetch.register`. */
export interface LoginRoutes {
  /** GET the page. */
  page: () => Promise<Response>
  /** GET the current state. */
  status: () => Promise<Response>
  /** GET the QR as an SVG. */
  qrImage: () => Promise<Response>
  /** POST to begin an attempt. */
  begin: () => Promise<Response>
  /** POST the verify code the phone displayed. */
  verifyCode: (request: Request) => Promise<Response>
}

/** JSON response that no cache may hold, so a poll always sees fresh state. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * Build the login routes.
 * @param options - the attempt to read and drive.
 * @returns one handler per route.
 */
export function createLoginRoutes(options: LoginRoutesOptions): LoginRoutes {
  const { session } = options

  return {
    async page(): Promise<Response> {
      return new Response(LOGIN_PAGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    },

    async status(): Promise<Response> {
      const snapshot = session.snapshot()
      // A URL that is absent is left out rather than sent as null: the page
      // shows the image when one is present, and null would read as present.
      return json({
        phase: snapshot.phase,
        ...(snapshot.qrcodeUrl === undefined ? {} : { qrcodeUrl: snapshot.qrcodeUrl }),
        ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
        ...(snapshot.accountId === undefined ? {} : { accountId: snapshot.accountId }),
      })
    },

    async qrImage(): Promise<Response> {
      const url = session.snapshot().qrcodeUrl
      if (url === undefined) {
        // Reached before the page began an attempt. A blank image would look
        // like a rendering bug rather than "nothing has started".
        return new Response('no qr available', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      return new Response(renderQrSvg(url), {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    },

    async begin(): Promise<Response> {
      session.start()
      return json({ phase: session.snapshot().phase })
    },

    async verifyCode(request: Request): Promise<Response> {
      const form = await request.formData()
      const raw = form.get('code')
      const code = typeof raw === 'string' ? raw.trim() : ''
      if (code === '') {
        // An accidental submit must not spend the retry budget: the server
        // counts an empty code as a wrong one.
        return json({ error: '验证码为空' }, 400)
      }
      session.submitVerifyCode(code)
      return json({ phase: session.snapshot().phase })
    },
  }
}

/**
 * The whole login page: markup, styles, and its polling script.
 *
 * Kept as one template literal so the artifact has no build step and no
 * separate client bundle to keep in sync.
 */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接微信</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
         margin: 0; display: flex; justify-content: center; padding: 2rem 1rem; }
  main { width: 100%; max-width: 26rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #666; line-height: 1.6; margin: 0.5rem 0; }
  #qr { width: 16rem; height: 16rem; margin: 1rem auto; display: none;
        border: 1px solid #e2e5e9; border-radius: 0.5rem; background: #fff; }
  #qr[data-visible="true"] { display: block; }
  button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 0.375rem;
           border: 1px solid #d0d5dd; background: #fff; cursor: pointer; }
  button:hover { background: #f9fafb; }
  input { font: inherit; padding: 0.5rem; width: 8rem; text-align: center;
          border: 1px solid #d0d5dd; border-radius: 0.375rem; }
  form { display: none; gap: 0.5rem; justify-content: center; margin-top: 0.5rem; }
  form[data-visible="true"] { display: flex; }
  .ok { color: #067647; }
  .err { color: #b42318; }
</style>
</head>
<body>
<main>
  <h1>连接微信</h1>
  <p id="hint">正在准备二维码…</p>
  <img id="qr" alt="微信登录二维码">
  <form id="verify" method="dialog">
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码">
    <button type="submit">提交</button>
  </form>
  <p><button id="restart" type="button" hidden>重新连接</button></p>
</main>
<script>
(function () {
  var hint = document.getElementById('hint');
  var qr = document.getElementById('qr');
  var form = document.getElementById('verify');
  var restart = document.getElementById('restart');
  var TEXT = {
    idle: '正在准备二维码…',
    waiting: '请用手机微信扫描二维码',
    scanned: '已扫描，请在手机上确认',
    'need-verifycode': '请输入手机上显示的验证码',
    connected: '已连接，可以关闭此页面',
    'already-connected': '此 Harness 已连接过微信',
    failed: '连接失败'
  };

  // The code is fetched from the image endpoint, which re-renders on every
  // request, so a refreshed code appears without the page tracking it.
  function draw(status) {
    if (status.qrcodeUrl) {
      qr.src = '/api/channel-wechat/qr.svg?t=' + Date.now();
      qr.dataset.visible = 'true';
    } else {
      qr.dataset.visible = 'false';
    }
    form.dataset.visible = status.phase === 'need-verifycode' ? 'true' : 'false';
    hint.textContent = status.message || TEXT[status.phase] || status.phase;
    hint.className = status.phase === 'connected' ? 'ok'
      : status.phase === 'failed' ? 'err' : '';
    restart.hidden = !(status.phase === 'connected' || status.phase === 'failed');
  }

  function poll() {
    fetch('/api/channel-wechat/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (status) {
        draw(status);
        // Stop polling once nothing more can change, so a finished page is idle.
        if (status.phase !== 'connected' && status.phase !== 'already-connected'
            && status.phase !== 'failed') setTimeout(poll, 1000);
      })
      .catch(function () { setTimeout(poll, 2000) });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var body = new URLSearchParams();
    body.set('code', document.getElementById('code').value);
    fetch('/api/channel-wechat/verify-code', { method: 'POST', body: body })
      .then(function () { document.getElementById('code').value = '' });
  });

  restart.addEventListener('click', function () {
    fetch('/api/channel-wechat/begin', { method: 'POST' }).then(poll);
  });

  fetch('/api/channel-wechat/begin', { method: 'POST' })
    .then(poll)
    .catch(function () { hint.textContent = '无法连接 Host 接口'; hint.className = 'err' });
})();
</script>
</body>
</html>
`
