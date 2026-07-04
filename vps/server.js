/* ============================================================
   Your Ai Music — VPS backend (Node.js + Express + SQLite)
   - Раздаёт фронтенд (public/index.html)
   - API для мини-аппки (валидация Telegram initData)
   - Telegram-бот через long polling (без вебхуков и SSL-возни)
   - Рефералка: +1 генерация за первую покупку реферала, 30% с покупок
   - Оплата Telegram Stars (реальная), карта/крипта — пока симуляция
   - Админ-команды в боте только для ADMIN_ID
============================================================ */

import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { BOT_TOKEN, ADMIN_ID, BOT_USERNAME, PUBLIC_URL } = process.env;
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('Заполните .env (BOT_TOKEN, ADMIN_ID)'); process.exit(1);
}

/* ================= DB ================= */
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
try { db.exec('ALTER TABLE withdrawals ADD COLUMN network TEXT'); } catch {} // миграция для старых БД

const WD_NETWORKS = ['Arbitrum', 'Solana', 'BEP20', 'TRC20', 'ERC20']; // вывод крипты — только USDT

const PACKS = {
  mini: { gens: 3,  stars: 50,  uah: 50  },
  std:  { gens: 10, stars: 100, uah: 100 },
  half: { gens: 20, stars: 200, uah: 200 },
  maxi: { gens: 50, stars: 400, uah: 400 },
};
const REF_PERCENT = 0.30;   // 30% от покупок рефералов
const WD_MIN = 50;          // мин. вывод, грн
const FREE_CREDITS = 1;     // бесплатных генераций новому пользователю

/* ================= Telegram API ================= */
async function tgApi(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}
const send = (chatId, text, extra = {}) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

/* ================= Users ================= */
const qGetUser = db.prepare('SELECT * FROM users WHERE id = ?');
const qInsertUser = db.prepare(
  'INSERT INTO users (id, username, name, credits, ref_by) VALUES (?, ?, ?, ?, ?)');

function upsertUser(tgu, refBy = null) {
  let u = qGetUser.get(tgu.id);
  if (!u) {
    const name = [tgu.first_name, tgu.last_name].filter(Boolean).join(' ');
    const validRef = refBy && refBy !== tgu.id && qGetUser.get(refBy) ? refBy : null;
    qInsertUser.run(tgu.id, tgu.username || null, name, FREE_CREDITS, validRef);
    u = qGetUser.get(tgu.id);
  }
  return u;
}

function refStats(userId) {
  const invited = db.prepare('SELECT COUNT(*) n FROM users WHERE ref_by = ?').get(userId).n;
  const buyers = db.prepare(
    'SELECT COUNT(*) n FROM users WHERE ref_by = ? AND has_purchased = 1').get(userId).n;
  const earned = db.prepare(`
    SELECT COALESCE(SUM(p.amount_uah), 0) s FROM purchases p
    JOIN users u ON u.id = p.user_id
    WHERE u.ref_by = ? AND p.pack != 'deposit'`).get(userId).s * REF_PERCENT;
  return { invited, buyers, earned: Math.round(earned) };
}

/* Начисление покупки пакета + реферальные бонусы. Всё в транзакции. */
const applyPackPurchase = db.transaction((userId, packId, method) => {
  const pack = PACKS[packId];
  const u = qGetUser.get(userId);
  if (!pack || !u) throw new Error('bad purchase');

  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(pack.gens, userId);
  db.prepare(`INSERT INTO purchases (user_id, pack, gens, amount_uah, stars, method)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, packId, pack.gens, pack.uah, method === 'stars' ? pack.stars : 0, method);

  if (u.ref_by) {
    const bonus = pack.uah * REF_PERCENT;
    db.prepare('UPDATE users SET money = money + ? WHERE id = ?').run(bonus, u.ref_by);
    if (!u.has_purchased) {
      // первая покупка реферала → рефереру +1 генерация
      db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').run(u.ref_by);
    }
  }
  if (!u.has_purchased) {
    db.prepare('UPDATE users SET has_purchased = 1 WHERE id = ?').run(userId);
  }
});

/* ================= initData validation ================= */
function verifyInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const dataCheck = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (calc !== hash) return null;
    const authDate = Number(p.get('auth_date') || 0);
    if (Date.now() / 1000 - authDate > 86400) return null;  // старше суток
    return JSON.parse(p.get('user') || 'null');
  } catch { return null; }
}

/* ================= HTTP API ================= */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* каждый /api/* запрос должен содержать валидный initData */
app.use('/api', (req, res, next) => {
  const tgu = verifyInitData(req.body?.initData || '');
  if (!tgu) return res.status(401).json({ ok: false, error: 'auth' });
  req.tgUser = tgu;
  req.user = upsertUser(tgu);
  next();
});

function publicState(userId) {
  const u = qGetUser.get(userId);
  const songs = db.prepare(
    `SELECT name, genre, vocal, lyrics, substr(created_at,1,10) AS date
     FROM songs WHERE user_id = ? ORDER BY id DESC LIMIT 100`).all(userId);
  return {
    ok: true,
    credits: u.credits, money: Math.round(u.money), stars: u.stars,
    songs, ref: refStats(userId),
    refLink: `https://t.me/${BOT_USERNAME}?start=ref_${userId}`,
    isAdmin: String(userId) === String(ADMIN_ID),
  };
}

app.post('/api/me', (req, res) => res.json(publicState(req.user.id)));

/* создать песню: списывает 1 кредит, сохраняет песню */
app.post('/api/song', (req, res) => {
  const { name, genre, vocal, lyrics } = req.body;
  if (!name || !genre || !vocal) return res.json({ ok: false, error: 'bad_request' });
  const u = qGetUser.get(req.user.id);
  if (u.credits < 1) return res.json({ ok: false, error: 'no_credits' });
  db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ?').run(u.id);
  db.prepare('INSERT INTO songs (user_id, name, genre, vocal, lyrics) VALUES (?, ?, ?, ?, ?)')
    .run(u.id, String(name).slice(0, 64), genre, vocal, String(lyrics || '').slice(0, 8000));
  // TODO: здесь будет вызов ИИ-генерации музыки (Suno API и т.п.)
  res.json(publicState(u.id));
});

/* инвойс Telegram Stars: пакет или депозит произвольной суммы */
app.post('/api/invoice', async (req, res) => {
  const { pack, depositStars } = req.body;
  let title, payload, amount;
  if (pack && PACKS[pack]) {
    title = `Пакет «${pack}» — ${PACKS[pack].gens} генераций`;
    payload = JSON.stringify({ t: 'p', p: pack, u: req.user.id });
    amount = PACKS[pack].stars;
  } else if (Number(depositStars) >= 1) {
    amount = Math.floor(Number(depositStars));
    title = `Депозит ${amount} ⭐`;
    payload = JSON.stringify({ t: 'd', a: amount, u: req.user.id });
  } else return res.json({ ok: false, error: 'bad_request' });

  const r = await tgApi('createInvoiceLink', {
    title, description: 'Your Ai Music',
    payload, currency: 'XTR',
    prices: [{ label: title, amount }],
  });
  if (!r.ok) return res.json({ ok: false, error: 'tg' });
  res.json({ ok: true, link: r.result });
});

/* покупка пакета: с внутреннего баланса, либо карта/крипта (пока симуляция) */
app.post('/api/purchase', (req, res) => {
  const { pack, method } = req.body;
  if (!PACKS[pack]) return res.json({ ok: false, error: 'bad_request' });
  const u = qGetUser.get(req.user.id);
  const p = PACKS[pack];

  if (method === 'balance') {
    if (u.money >= p.uah) {
      db.prepare('UPDATE users SET money = money - ? WHERE id = ?').run(p.uah, u.id);
    } else if (u.stars >= p.stars) {
      db.prepare('UPDATE users SET stars = stars - ? WHERE id = ?').run(p.stars, u.id);
    } else return res.json({ ok: false, error: 'no_funds' });
    applyPackPurchase(u.id, pack, 'balance');
  } else if (method === 'card' || method === 'crypto') {
    // TODO: заменить на реальные колбэки MonoPay/WayForPay/крипто-процессинга
    applyPackPurchase(u.id, pack, method);
  } else return res.json({ ok: false, error: 'bad_request' });

  res.json(publicState(u.id));
});

/* депозит на внутренний баланс картой/криптой (пока симуляция) */
app.post('/api/deposit', (req, res) => {
  const amount = Math.floor(Number(req.body.amount));
  const { method } = req.body;
  if (!amount || amount < 1 || !['card', 'crypto'].includes(method))
    return res.json({ ok: false, error: 'bad_request' });
  // TODO: реальный платёжный колбэк
  db.prepare('UPDATE users SET money = money + ? WHERE id = ?').run(amount, req.user.id);
  db.prepare(`INSERT INTO purchases (user_id, pack, amount_uah, method)
              VALUES (?, 'deposit', ?, ?)`).run(req.user.id, amount, method);
  res.json(publicState(req.user.id));
});

/* заявка на вывод: реквизиты обязательны, баланс проверяет сервер.
   Крипта — только USDT, с обязательным выбором сети. */
app.post('/api/withdraw', (req, res) => {
  const method = req.body.method === 'crypto' ? 'crypto' : 'card';
  const details = String(req.body.details || '').trim().slice(0, 200);
  if (details.length < 5) return res.json({ ok: false, error: 'details' });

  let network = null;
  if (method === 'crypto') {
    network = WD_NETWORKS.includes(req.body.network) ? req.body.network : null;
    if (!network) return res.json({ ok: false, error: 'network' });
  }

  const u = qGetUser.get(req.user.id);
  if (u.money < WD_MIN) return res.json({ ok: false, error: 'min' });  // сумма реально есть на балансе
  const amount = Math.round(u.money);
  db.prepare('UPDATE users SET money = 0 WHERE id = ?').run(u.id);
  const info = db.prepare(
    `INSERT INTO withdrawals (user_id, amount, method, network, details) VALUES (?, ?, ?, ?, ?)`)
    .run(u.id, amount, method, network, details);

  send(ADMIN_ID,
    `💸 <b>Заявка на вывод #${info.lastInsertRowid}</b>\n` +
    `Юзер: <code>${u.id}</code> · @${u.username || '—'} · «${u.name || ''}»\n` +
    `Сумма: <b>${amount} грн</b>\n` +
    `Способ: ${method === 'crypto' ? `🪙 USDT · ${network}` : '💳 карта'}\n` +
    `Реквизиты: <code>${details}</code>`);
  res.json(publicState(u.id));
});

/* ================= ADMIN API (только ADMIN_ID) ================= */
app.use('/api/admin', (req, res, next) => {
  if (String(req.user.id) !== String(ADMIN_ID))
    return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
});

/* всё для главного экрана админки одним запросом */
app.post('/api/admin/overview', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    songs: db.prepare('SELECT COUNT(*) n FROM songs').get().n,
    uah: Math.round(db.prepare(`SELECT COALESCE(SUM(amount_uah),0) s FROM purchases`).get().s),
    stars: db.prepare(`SELECT COALESCE(SUM(stars),0) s FROM purchases`).get().s,
    wdCount: db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE status='pending'`).get().n,
    wdSum: Math.round(db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='pending'`).get().s),
  };
  const withdrawals = db.prepare(`
    SELECT w.*, u.username, u.name FROM withdrawals w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status = 'pending' ORDER BY w.id DESC LIMIT 50`).all();
  const wdHistory = db.prepare(`
    SELECT w.*, u.username FROM withdrawals w
    LEFT JOIN users u ON u.id = w.user_id
    WHERE w.status != 'pending' ORDER BY w.id DESC LIMIT 20`).all();
  const topRefs = db.prepare(`
    SELECT u.id, u.username, u.name,
           COUNT(DISTINCT r.id) invited,
           COALESCE(SUM(CASE WHEN p.pack != 'deposit' THEN p.amount_uah ELSE 0 END), 0) * ${REF_PERCENT} earned
    FROM users u
    JOIN users r ON r.ref_by = u.id
    LEFT JOIN purchases p ON p.user_id = r.id
    GROUP BY u.id ORDER BY invited DESC LIMIT 10`).all();
  const topSpenders = db.prepare(`
    SELECT u.id, u.username, u.name, COALESCE(SUM(p.amount_uah),0) spent
    FROM users u
    JOIN purchases p ON p.user_id = u.id AND p.pack != 'deposit'
    GROUP BY u.id ORDER BY spent DESC LIMIT 10`).all();
  const recent = db.prepare(`
    SELECT id, username, name, credits, money, stars
    FROM users ORDER BY created_at DESC LIMIT 10`).all();
  res.json({ ok: true, stats, withdrawals, wdHistory, topRefs, topSpenders, recent });
});

/* поиск по id или @username */
app.post('/api/admin/search', (req, res) => {
  const q = String(req.body.q || '').trim().replace(/^@/, '');
  const user = /^\d+$/.test(q)
    ? qGetUser.get(Number(q))
    : db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(q);
  if (!user) return res.json({ ok: true, user: null });
  const spent = db.prepare(
    `SELECT COALESCE(SUM(amount_uah),0) s FROM purchases WHERE user_id = ? AND pack != 'deposit'`).get(user.id).s;
  const songs = db.prepare('SELECT COUNT(*) n FROM songs WHERE user_id = ?').get(user.id).n;
  res.json({ ok: true, user, spent, songs, ref: refStats(user.id) });
});

/* начислить генерации / грн */
app.post('/api/admin/give', (req, res) => {
  const id = Number(req.body.id);
  if (!qGetUser.get(id)) return res.json({ ok: false, error: 'not_found' });
  if (Number(req.body.credits))
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(Number(req.body.credits), id);
  if (Number(req.body.money))
    db.prepare('UPDATE users SET money = money + ? WHERE id = ?').run(Number(req.body.money), id);
  res.json({ ok: true });
});

/* отметить вывод выплаченным */
app.post('/api/admin/wd_paid', (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(Number(req.body.id));
  if (!w) return res.json({ ok: false, error: 'not_found' });
  db.prepare(`UPDATE withdrawals SET status = 'paid' WHERE id = ?`).run(w.id);
  send(w.user_id, `✅ Ваша заявка на вывод ${w.amount} грн выполнена`);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`HTTP на :${PORT}`));

/* ================= BOT (long polling) ================= */
async function handleUpdate(up) {
  /* подтверждение оплаты Stars */
  if (up.pre_checkout_query) {
    await tgApi('answerPreCheckoutQuery', { pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
    return;
  }
  const msg = up.message;
  if (!msg) return;

  /* успешный платёж Stars */
  if (msg.successful_payment) {
    try {
      const pl = JSON.parse(msg.successful_payment.invoice_payload);
      if (pl.t === 'p') {                      // пакет
        applyPackPurchase(pl.u, pl.p, 'stars');
        await send(pl.u, `✅ Пакет активирован! +${PACKS[pl.p].gens} генераций`);
      } else if (pl.t === 'd') {               // депозит в ⭐
        db.prepare('UPDATE users SET stars = stars + ? WHERE id = ?').run(pl.a, pl.u);
        db.prepare(`INSERT INTO purchases (user_id, pack, stars, method)
                    VALUES (?, 'deposit', ?, 'stars')`).run(pl.u, pl.a);
        await send(pl.u, `✅ Баланс пополнен на ${pl.a} ⭐`);
      }
    } catch (e) { console.error('payment error', e); }
    return;
  }

  const text = msg.text || '';
  const from = msg.from;

  /* /start [ref_XXX] */
  if (text.startsWith('/start')) {
    const m = text.match(/ref_(\d+)/);
    upsertUser(from, m ? Number(m[1]) : null);
    await send(from.id,
      `🎵 <b>Your Ai Music</b>\nСоздай свою песню с ИИ за пару минут. Первая — бесплатно!`,
      { reply_markup: { inline_keyboard: [[{ text: '🎹 Открыть конструктор', web_app: { url: PUBLIC_URL } }]] } });
    return;
  }

  /* ---------- админ-команды (только ADMIN_ID) ---------- */
  if (String(from.id) !== String(ADMIN_ID)) return;

  if (text === '/stats') {
    const s = {
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      songs: db.prepare('SELECT COUNT(*) n FROM songs').get().n,
      revUah: db.prepare(`SELECT COALESCE(SUM(amount_uah),0) s FROM purchases WHERE method IN ('card','crypto')`).get().s,
      revStars: db.prepare(`SELECT COALESCE(SUM(stars),0) s FROM purchases WHERE method='stars'`).get().s,
      wd: db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE status='pending'`).get().n,
    };
    await send(from.id,
      `📊 <b>Статистика</b>\nПользователей: ${s.users}\nПесен: ${s.songs}\n` +
      `Выручка: ${s.revUah} грн + ${s.revStars} ⭐\nЗаявок на вывод: ${s.wd}`);
  } else if (text.startsWith('/user ')) {
    const u = qGetUser.get(Number(text.split(' ')[1]));
    await send(from.id, u
      ? `👤 <code>${u.id}</code> @${u.username || '—'} «${u.name}»\n` +
        `Кредиты: ${u.credits} · Баланс: ${Math.round(u.money)} грн · ⭐ ${u.stars}\n` +
        `Пригласил: ${refStats(u.id).invited} · Реферер: ${u.ref_by || '—'}`
      : 'Не найден');
  } else if (text.startsWith('/give ')) {
    const [, id, n] = text.split(' ');
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(Number(n), Number(id));
    await send(from.id, `✅ Юзеру ${id} добавлено ${n} генераций`);
  } else if (text.startsWith('/money ')) {
    const [, id, n] = text.split(' ');
    db.prepare('UPDATE users SET money = money + ? WHERE id = ?').run(Number(n), Number(id));
    await send(from.id, `✅ Юзеру ${id} добавлено ${n} грн`);
  } else if (text === '/wd') {
    const rows = db.prepare(`SELECT * FROM withdrawals WHERE status='pending' ORDER BY id`).all();
    await send(from.id, rows.length
      ? rows.map(w => `#${w.id} · ${w.user_id} · ${w.amount} грн · ${w.method}\n→ /wd_paid ${w.id}`).join('\n\n')
      : 'Заявок нет');
  } else if (text.startsWith('/wd_paid ')) {
    const id = Number(text.split(' ')[1]);
    db.prepare(`UPDATE withdrawals SET status='paid' WHERE id = ?`).run(id);
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (w) await send(w.user_id, `✅ Ваша заявка на вывод ${w.amount} грн выполнена`);
    await send(from.id, `Готово`);
  } else if (text === '/admin' || text === '/help') {
    await send(from.id,
      `🛠 <b>Админ-команды</b>\n/stats — статистика\n/user &lt;id&gt; — инфо о юзере\n` +
      `/give &lt;id&gt; &lt;n&gt; — выдать генерации\n/money &lt;id&gt; &lt;n&gt; — начислить грн\n` +
      `/wd — заявки на вывод\n/wd_paid &lt;id&gt; — отметить выплаченной`);
  }
}

async function pollLoop() {
  let offset = 0;
  console.log('Бот: long polling запущен');
  for (;;) {
    try {
      const r = await tgApi('getUpdates', {
        offset, timeout: 30,
        allowed_updates: ['message', 'pre_checkout_query'],
      });
      if (r.ok) for (const up of r.result) {
        offset = up.update_id + 1;
        handleUpdate(up).catch(e => console.error('update error', e));
      }
    } catch (e) {
      console.error('poll error', e.message);
      await new Promise(s => setTimeout(s, 3000));
    }
  }
}
pollLoop();
