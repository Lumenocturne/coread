// reader.js — 章节页交互:选文批注/发起讨论、批注气泡(含"聊这条")、共读聊天面板(SSE 流式)。
// 独立静态文件,所有正则和 \n 都只写一层——别把这些塞回服务端模板字面量(防踩坑 #6)。
(function () {
  var CFG = window.__COREAD || {};
  var content = document.getElementById('content');
  var selTxt = '', quote = '', annCtx = null, sheet = null, bar = null;

  // ── 底部选文条 ──
  function buildBar() {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '#cr-bar{position:fixed;left:0;right:0;bottom:0;z-index:200;background:var(--bg);border-top:1px solid var(--line);padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 14px);display:none}' +
      '#cr-bar.show{display:block}' +
      '#cr-bar .hint{font-size:12px;color:var(--soft);font-style:italic;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#cr-bar textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--tx);padding:10px;font-size:14px;font-family:inherit;line-height:1.6}' +
      '#cr-bar .btns{display:flex;gap:10px;margin-top:8px}' +
      '#cr-bar button{padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:none;color:var(--soft);font-size:13px;cursor:pointer;font-family:inherit}' +
      '#cr-bar button.save{color:var(--acc);border-color:var(--acc)}' +
      '.cr-bub{position:fixed;z-index:210;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;max-width:300px;box-shadow:0 8px 24px rgba(0,0,0,.15)}' +
      '.cr-bub .who{font-size:11px;color:var(--faint);margin-bottom:4px}' +
      '.cr-bub .txt{font-size:13.5px;line-height:1.7;white-space:pre-wrap}' +
      '.cr-bub .acts{margin-top:8px;text-align:right}' +
      '.cr-bub .acts span{font-size:11px;color:var(--soft);cursor:pointer;margin-left:12px}' +
      '</style>');
    bar = document.createElement('div');
    bar.id = 'cr-bar';
    bar.innerHTML = '<div class="hint"></div><textarea placeholder="写一条批注…"></textarea><div class="btns"><button onclick="this.closest(\'#cr-bar\').classList.remove(\'show\')">取消</button><button class="save" id="cr-save">保存批注</button><button class="save" id="cr-talk">聊这句</button></div>';
    document.body.appendChild(bar);
    document.getElementById('cr-save').onclick = function () {
      var tx = bar.querySelector('textarea').value.trim();
      if (!tx || !selTxt) return;
      fetch('/api/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book_id: CFG.bid, chapter_num: CFG.cnum, original_text: selTxt, annotation: tx }) })
        .then(function () { location.reload(); });
    };
    document.getElementById('cr-talk').onclick = function () { openSheet(selTxt, null); bar.classList.remove('show'); };
  }
  buildBar();

  content.addEventListener('mouseup', function () { setTimeout(checkSel, 80); });
  content.addEventListener('touchend', function () { setTimeout(checkSel, 350); });
  function checkSel() {
    var s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return;
    var t = s.toString().trim();
    if (!t || t.length < 2 || !content.contains(s.anchorNode)) return;
    selTxt = t;
    bar.querySelector('.hint').textContent = '「' + (t.length > 30 ? t.slice(0, 30) + '…' : t) + '」';
    bar.querySelector('textarea').value = '';
    bar.classList.add('show');
  }

  // ── 批注气泡(点已画线的文字) ──
  document.addEventListener('click', function (e) {
    var old = document.querySelector('.cr-bub');
    if (old && !old.contains(e.target)) old.remove();
    var el = e.target.closest('[data-anns]');
    if (!el) return;
    var anns = JSON.parse(el.dataset.anns);
    var bub = document.createElement('div');
    bub.className = 'cr-bub';
    bub.innerHTML = anns.map(function (a, i) {
      return '<div' + (i ? ' style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"' : '') + '><div class="who">' + (a.w === 'user' ? '读者' : 'AI') + (a.t ? ' · ' + a.t : '') + '</div><div class="txt"></div><div class="acts"><span data-i="' + i + '">聊这条</span></div></div>';
    }).join('');
    bub.querySelectorAll('.txt').forEach(function (d, i) { d.textContent = anns[i].a; });
    bub.querySelectorAll('.acts span').forEach(function (s) {
      s.onclick = function (ev) {
        ev.stopPropagation();
        var a = anns[s.dataset.i | 0];
        bub.remove();
        openSheet(el.textContent || '', { who: a.w, text: a.a });
      };
    });
    document.body.appendChild(bub);
    var rc = el.getBoundingClientRect(), w = Math.min(300, innerWidth - 32);
    bub.style.width = w + 'px';
    bub.style.left = Math.max(16, Math.min(rc.left + rc.width / 2 - w / 2, innerWidth - w - 16)) + 'px';
    bub.style.top = (rc.bottom + 8 + bub.offsetHeight > innerHeight ? rc.top - bub.offsetHeight - 8 : rc.bottom + 8) + 'px';
  });

  // ── 共读聊天面板 ──
  function buildSheet() {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '#cr-sheet{position:fixed;left:0;right:0;bottom:0;z-index:300;background:var(--bg);border-top:1px solid var(--line);border-radius:16px 16px 0 0;transform:translateY(115%);transition:transform .3s;max-height:78vh;display:flex;flex-direction:column;box-shadow:0 -10px 36px rgba(0,0,0,.15)}' +
      '#cr-sheet.show{transform:translateY(0)}' +
      '#cr-sheet .hd{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--acc);align-items:flex-start}' +
      '#cr-sheet .hd .x{margin-left:auto;cursor:pointer;color:var(--faint);font-size:18px;line-height:1}' +
      '#cr-sheet .log{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:130px}' +
      '#cr-sheet .m{max-width:85%;padding:8px 12px;border-radius:12px;font-size:14.5px;line-height:1.6;white-space:pre-wrap}' +
      '#cr-sheet .me{align-self:flex-end;background:var(--acc);color:var(--bg)}' +
      '#cr-sheet .ai{align-self:flex-start;background:var(--card)}' +
      '#cr-sheet .note{align-self:center;font-size:11px;color:var(--faint);font-style:italic}' +
      '#cr-sheet .in{display:flex;gap:8px;padding:10px 14px calc(env(safe-area-inset-bottom,0px) + 12px);border-top:1px solid var(--line)}' +
      '#cr-sheet textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:16px;padding:8px 13px;font-size:14.5px;font-family:inherit;background:var(--card);color:var(--tx)}' +
      '#cr-sheet .send{border:none;background:var(--acc);color:var(--bg);border-radius:50%;width:38px;height:38px;cursor:pointer;font-size:16px}' +
      '</style>');
    sheet = document.createElement('div');
    sheet.id = 'cr-sheet';
    sheet.innerHTML = '<div class="hd"><span class="q"></span><span class="x">✕</span></div><div class="log"></div><div class="in"><textarea rows="1" placeholder="聊聊这本书…"></textarea><button class="send">↑</button></div>';
    document.body.appendChild(sheet);
    sheet.querySelector('.x').onclick = function () { sheet.classList.remove('show'); };
    sheet.querySelector('.send').onclick = send;
    sheet.querySelector('textarea').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    // 讨论历史落库了,开面板先续上——共读是一条连续的河(防踩坑 #7)
    fetch('/api/reading/' + CFG.bid + '/chats').then(function (r) { return r.json(); }).then(function (d) {
      (d.items || []).forEach(function (c) { add(c.who === 'user' ? 'me' : 'ai', c.text); });
    });
  }

  function add(cls, text) {
    var log = sheet.querySelector('.log');
    var el = document.createElement('div');
    el.className = 'm ' + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function openSheet(sel, ann) {
    quote = sel || '';
    annCtx = ann || null;
    if (!sheet) buildSheet();
    sheet.querySelector('.q').textContent = quote ? '「' + (quote.length > 60 ? quote.slice(0, 60) + '…' : quote) + '」' + (ann ? ' · 聊这条批注' : '') : '聊聊这本书';
    sheet.classList.add('show');
    setTimeout(function () { sheet.querySelector('textarea').focus(); }, 120);
  }

  function send() {
    var ta = sheet.querySelector('textarea');
    var m = ta.value.trim();
    if (!m) return;
    ta.value = '';
    add('me', m);
    var t = add('ai', '…');
    var log = sheet.querySelector('.log');
    var _ann = annCtx; annCtx = null; // 批注上下文只随第一条消息带
    // SSE:fetch + ReadableStream 手工分帧(EventSource 不支持 POST)。
    fetch('/api/reading/' + CFG.bid + '/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ cnum: CFG.cnum, message: m, selection: quote, ann: _ann || undefined }),
    }).then(function (r) {
      var rd = r.body.getReader(), dec = new TextDecoder('utf-8'), buf = '', done = false;
      function pump() {
        return rd.read().then(function (x) {
          if (x.done) { if (!done) t.textContent = '（流断了，再说一遍？）'; return; }
          buf += dec.decode(x.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var fr = buf.slice(0, i); buf = buf.slice(i + 2);
            var em = /^event: (\S+)$/m.exec(fr), dm = /^data: (.*)$/m.exec(fr);
            if (!em || !dm) continue;
            var d; try { d = JSON.parse(dm[1]); } catch (e) { continue; }
            if (em[1] === 'live') {
              t.textContent = (d.t || '').replace(/\n?\[批注[^\]]*\]?\s*$/, ''); // 半截批注标记别闪出来
              log.scrollTop = log.scrollHeight;
            } else if (em[1] === 'final') {
              done = true;
              t.textContent = (d.reply || '').trim() || d.error || '（没接住，再说一遍？）';
              if (d.ann) { var n = document.createElement('div'); n.className = 'note'; n.textContent = '—— AI 在这一页留下了画线批注，刷新可见 ——'; log.appendChild(n); }
              log.scrollTop = log.scrollHeight;
              try { rd.cancel(); } catch (e) {}
              return;
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { t.textContent = '（出错了：' + e.message + '）'; });
  }
})();
