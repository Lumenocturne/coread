// coread — 和你的 AI 一起读一本书
// 入口:建库、装路由。所有配置走环境变量,见 README。
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.COREAD_DB || path.join(__dirname, 'coread.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS books(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT DEFAULT '',
  last_chapter INTEGER DEFAULT 0,
  last_read_at TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS chapters(
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chapter_num INTEGER NOT NULL,
  title TEXT DEFAULT '', content TEXT DEFAULT '',
  digest TEXT DEFAULT ''            -- 每章≤120字脉络摘要,便宜模型懒生成(防剧透注入的原料)
);
CREATE TABLE IF NOT EXISTS annotations(
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chapter_num INTEGER NOT NULL,
  original_text TEXT DEFAULT '',    -- 被画线的原文片段(必须真是本章子串)
  annotation TEXT NOT NULL,
  annotator TEXT NOT NULL,          -- 'user' | 'ai'
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reading_chats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL, cnum INTEGER DEFAULT 0,
  who TEXT NOT NULL,                -- 'user' | 'ai'
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rchats_book ON reading_chats(book_id, id);
`);

const app = express();
app.use(express.json({ limit: '1mb' }));

require('./routes/epub')(app, db);
require('./routes/reader')(app, db);
require('./routes/chat')(app, db);

const PORT = process.env.PORT || 3900;
app.listen(PORT, () => console.log('coread up: http://localhost:' + PORT + '/reading'));
