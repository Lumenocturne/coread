// reader.js — 三张页面:书架 / 目录 / 章节(批注+共读)。
// 服务端直出 HTML,零构建零框架;交互逻辑在 public/reader.js(独立静态文件——
// ⚠️ 防踩坑 #6:别把浏览器 JS 塞进服务端模板字面量,正则和 \n 要转义两层,极易写错)。
const path = require('path');
const express = require('express');
const { fillDigests } = require('../lib/digest');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#faf9f7;--tx:#1f1f1e;--soft:rgba(31,31,30,.62);--faint:rgba(31,31,30,.4);--line:rgba(31,31,30,.1);--card:rgba(31,31,30,.04);--acc:#b0543f;--hl:rgba(176,160,200,.3)}
@media(prefers-color-scheme:dark){:root{--bg:#1e1e1d;--tx:#f5f4f1;--soft:rgba(245,244,241,.66);--faint:rgba(245,244,241,.4);--line:rgba(245,244,241,.12);--card:rgba(245,244,241,.06);--hl:rgba(176,160,200,.28)}}
body{font-family:Georgia,'Songti SC','Noto Serif SC',serif;background:var(--bg);color:var(--tx);min-height:100vh;padding-bottom:70px}
.wrap{max-width:660px;margin:0 auto;padding:28px 20px}
a{color:inherit;text-decoration:none}
h1{font-size:22px;font-weight:400;letter-spacing:1px;margin-bottom:4px}
.sub{font-size:13px;color:var(--faint);font-style:italic;margin-bottom:24px}
.back{display:inline-block;font-size:13px;color:var(--faint);margin-bottom:16px}
ul.plain{list-style:none}
.row{display:block;padding:12px 4px;border-bottom:1px solid var(--line);font-size:15px}
.row small{color:var(--faint);margin-left:8px;font-size:12px}
.content{font-size:16.5px;line-height:1.9;white-space:pre-wrap;margin:20px 0}
.hl-user{background:var(--hl);border-radius:6px;padding:.06em 2px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.hl-ai{border-bottom:1.5px solid var(--acc);padding-bottom:1px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.nav{display:flex;justify-content:space-between;margin-top:32px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--soft)}
.up{font-size:13px;color:var(--soft);border:1px dashed var(--line);border-radius:8px;padding:10px 14px;display:inline-block;cursor:pointer}
`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

// 服务端把批注嵌进正文:按原文片段找到位置,包上 span(用户=高亮 / AI=下划线)。
// 嵌不进的(原文没匹配上)不丢,前端沉底显示。
function embed(content, anns) {
  let html = esc(content || '');
  const embedded = new Set();
  const groups = new Map();
  for (const a of anns) {
    if (!a.original_text || !a.original_text.trim()) continue;
    const key = esc(a.original_text);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const keys = [...groups.keys()].sort((x, y) => y.length - x.length); // 长引文优先,避免短的先占坑
  for (const key of keys) {
    const idx = html.indexOf(key);
    if (idx < 0) continue;
    const before = html.slice(0, idx);
    if ((before.match(/<span class="hl-/g) || []).length > (before.match(/<\/span>/g) || []).length) continue; // 已在别的标注里,跳过
    const grp = groups.get(key);
    grp.forEach((a) => embedded.add(a.id));
    const cls = [...new Set(grp.map((a) => (a.annotator === 'user' ? 'hl-user' : 'hl-ai')))].join(' ');
    const data = esc(JSON.stringify(grp.map((a) => ({ id: a.id, w: a.annotator, a: a.annotation, t: a.created_at }))));
    html = html.slice(0, idx) + `<span class="${cls}" data-anns="${data}">` + key + '</span>' + html.slice(idx + key.length);
  }
  return { html, floating: anns.filter((a) => !embedded.has(a.id)) };
}

module.exports = function (app, db) {
  app.use('/public', express.static(path.join(__dirname, '..', 'public')));

  // 书架
  app.get('/reading', (q, r) => {
    const books = db.prepare('SELECT b.*, COUNT(c.id) n FROM books b LEFT JOIN chapters c ON c.book_id=b.id GROUP BY b.id ORDER BY b.last_read_at DESC').all();
    const list = books.map((b) => `<li><a class="row" href="/reading/${b.id}">${esc(b.title)}<small>${esc(b.author)} · ${b.n}章${b.last_chapter ? ' · 读到第' + b.last_chapter + '章' : ''}</small></a></li>`).join('');
    r.send(page('书架', `<div class="wrap"><h1>书架</h1><p class="sub">falling in love on the same page</p><ul class="plain">${list || '<li class="row">书架还是空的。</li>'}</ul>
<p style="margin-top:24px"><label class="up">导入 epub<input type="file" accept=".epub" style="display:none" onchange="var fd=new FormData();fd.append('epub',this.files[0]);fetch('/api/import-epub',{method:'POST',body:fd}).then(r=>r.json()).then(d=>d.success?location.href='/reading/'+d.book_id:alert(d.error))"></label></p></div>`));
  });

  // 目录
  app.get('/reading/:bid', (q, r) => {
    const b = db.prepare('SELECT * FROM books WHERE id=?').get(q.params.bid);
    if (!b) return r.status(404).send('Not found');
    const chs = db.prepare('SELECT chapter_num,title FROM chapters WHERE book_id=? ORDER BY chapter_num').all(b.id);
    const list = chs.map((c) => `<li><a class="row" href="/reading/${b.id}/${c.chapter_num}">#${c.chapter_num} ${esc(c.title)}${c.chapter_num === b.last_chapter ? '<small>上次读到</small>' : ''}</a></li>`).join('');
    r.send(page(b.title, `<div class="wrap"><a class="back" href="/reading">← 书架</a><h1>${esc(b.title)}</h1><p class="sub">${esc(b.author)}</p><ul class="plain">${list}</ul></div>`));
  });

  // 章节(阅读+批注+共读聊天)
  app.get('/reading/:bid/:cnum', (q, r) => {
    const b = db.prepare('SELECT * FROM books WHERE id=?').get(q.params.bid);
    const cnum = parseInt(q.params.cnum, 10) || 0;
    const ch = db.prepare('SELECT * FROM chapters WHERE book_id=? AND chapter_num=?').get(q.params.bid, cnum);
    if (!b || !ch) return r.status(404).send('Not found');
    db.prepare("UPDATE books SET last_read_at=datetime('now','localtime'), last_chapter=? WHERE id=?").run(cnum, b.id);
    setImmediate(() => { try { fillDigests(db, b.id, cnum); } catch (e) {} }); // 翻到哪,digest 后台补到哪

    const anns = db.prepare('SELECT * FROM annotations WHERE book_id=? AND chapter_num=? ORDER BY created_at').all(b.id, cnum);
    const { html, floating } = embed(String(ch.content).replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n'), anns);
    const prev = cnum > 1 ? `<a href="/reading/${b.id}/${cnum - 1}">← 上一章</a>` : '<span></span>';
    const next = db.prepare('SELECT 1 FROM chapters WHERE book_id=? AND chapter_num=?').get(b.id, cnum + 1) ? `<a href="/reading/${b.id}/${cnum + 1}">下一章 →</a>` : '<span></span>';
    const floatH = floating.length
      ? '<div style="margin-top:28px;border-top:1px solid var(--line);padding-top:14px">' + floating.map((a) => `<p style="font-size:13px;color:var(--soft);margin-bottom:10px">${a.annotator === 'user' ? '读者' : 'AI'}：${a.original_text ? '「' + esc(a.original_text) + '」— ' : ''}${esc(a.annotation)}</p>`).join('') + '</div>'
      : '';
    r.send(page(ch.title || b.title, `<div class="wrap"><a class="back" href="/reading/${b.id}">← 目录</a><h1>${esc(ch.title)}</h1><p class="sub">${esc(b.title)} · #${cnum}</p>
<div class="content" id="content">${html}</div>${floatH}<div class="nav">${prev}${next}</div></div>
<script>window.__COREAD={bid:${JSON.stringify(b.id)},cnum:${cnum}}</script><script src="/public/reader.js"></script>`));
  });

  // 手动批注
  app.post('/api/annotate', (q, r) => {
    const { book_id, chapter_num, original_text, annotation } = q.body || {};
    if (!book_id || !annotation) return r.status(400).json({ error: 'missing' });
    db.prepare('INSERT INTO annotations(id,book_id,chapter_num,original_text,annotation,annotator) VALUES(?,?,?,?,?,?)')
      .run(require('crypto').randomUUID(), book_id, parseInt(chapter_num, 10) || 0, String(original_text || '').slice(0, 500), String(annotation).slice(0, 2000), 'user');
    r.json({ success: true });
  });
};
