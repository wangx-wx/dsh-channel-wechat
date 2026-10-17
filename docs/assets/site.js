/*
  落地页与文章页共用的少量交互。

  只有一件事：给命令块加「复制」。按钮不携带命令文本，而是从同组 <code> 读
  textContent —— 这样命令只有一处定义，改命令不会忘记改按钮上的副本。
*/

(function () {
  'use strict'

  var RESET_MS = 2000

  /** 复制文本；返回是否成功。 */
  function copyText(text) {
    // navigator.clipboard 只在安全上下文可用（https/localhost）。
    // 站点可能是 http 的局域网地址，所以保留 execCommand 这条退路。
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true },
        function () { return legacyCopy(text) },
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea')
    area.value = text
    // 放在视口外，避免滚动跳动
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    var ok = false
    try {
      ok = document.execCommand('copy')
    } catch (error) {
      ok = false
    }
    document.body.removeChild(area)
    return ok
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]')
    if (!button) return

    var scope = button.closest('.cmd')
    var code = scope ? scope.querySelector('code') : null
    if (!code) return

    var label = button.getAttribute('data-copy') || '复制'
    var original = button.textContent

    copyText(code.textContent).then(function (ok) {
      button.textContent = ok ? label : '复制失败，请手动选中'
      button.classList.toggle('copied', ok)
      window.setTimeout(function () {
        button.textContent = original
        button.classList.remove('copied')
      }, RESET_MS)
    })
  })
})()
