-- Your Ai Music — D1 schema
-- Применить: wrangler d1 execute yourmusic-db --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,          -- Telegram user id
  username      TEXT,
  name          TEXT,
  credits       INTEGER NOT NULL DEFAULT 1,   -- 1 бесплатная генерация новому юзеру
  money         REAL    NOT NULL DEFAULT 0,   -- баланс в грн (реф. начисления, депозиты)
  stars         INTEGER NOT NULL DEFAULT 0,   -- баланс в Telegram Stars
  ref_by        INTEGER,                      -- кто пригласил (users.id)
  has_purchased INTEGER NOT NULL DEFAULT 0,   -- была ли хоть одна покупка (для +1 ген рефереру)
  lang          TEXT    NOT NULL DEFAULT 'ru',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS songs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  genre      TEXT NOT NULL,
  vocal      TEXT NOT NULL,
  lyrics     TEXT,
  audio_url  TEXT,                            -- заполнится, когда подключим ИИ-генерацию
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  pack       TEXT    NOT NULL,                -- mini | std | half | maxi | deposit
  gens       INTEGER NOT NULL DEFAULT 0,
  amount_uah REAL    NOT NULL DEFAULT 0,
  stars      INTEGER NOT NULL DEFAULT 0,
  method     TEXT    NOT NULL,                -- stars | card | crypto | balance
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  amount     REAL    NOT NULL,
  method     TEXT    NOT NULL,                -- card | crypto
  network    TEXT,                            -- для crypto: Arbitrum | Solana | BEP20 | TRC20 | ERC20
  details    TEXT,                            -- номер карты / адрес кошелька USDT
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | paid | rejected
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_songs_user      ON songs(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_user  ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_users_ref       ON users(ref_by);
