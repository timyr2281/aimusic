# Your Ai Music — деплой на VPS

Весь стек на одном сервере: Node.js (бот + API + фронтенд) + SQLite + Caddy (HTTPS).
Подходит Hetzner CX22 (~€4/мес) или любой Ubuntu 22.04/24.04 VPS.

## Что нужно заранее

1. **Бот**: создайте в @BotFather → `/newbot` → сохраните токен.
2. **Ваш Telegram id**: напишите @userinfobot — он пришлёт ваш id (это будет админ-аккаунт).
3. **Домен**: любой (даже за $1-2/год). DNS A-запись домена → IP вашего VPS.
   Без домена Telegram Mini App работать не будет — нужен HTTPS.

## Шаг 1. Сервер

```bash
ssh root@ВАШ_IP

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (реверс-прокси с автоматическим SSL)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

## Шаг 2. Код

С вашего компьютера (из папки, где лежит `vps/`):

```bash
scp -r vps root@ВАШ_IP:/opt/yourmusic
```

На сервере:

```bash
cd /opt/yourmusic
npm install
cp .env.example .env
nano .env        # вписать BOT_TOKEN, ADMIN_ID, BOT_USERNAME, PUBLIC_URL
```

Проверка: `node server.js` — должно написать `HTTP на :3000` и `Бот: long polling запущен`. Ctrl+C.

## Шаг 3. Автозапуск

```bash
cp yourmusic.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yourmusic
systemctl status yourmusic     # active (running)
journalctl -u yourmusic -f     # живые логи
```

## Шаг 4. HTTPS

```bash
nano /etc/caddy/Caddyfile
```

Содержимое (замените домен):

```
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
systemctl reload caddy
```

Откройте `https://yourdomain.com` в браузере — должна открыться мини-аппка.

## Шаг 5. Подключение к Telegram

В @BotFather:
- `/mybots` → ваш бот → **Bot Settings → Menu Button → Configure menu button** → вставьте `https://yourdomain.com`
- (опционально) **Configure Mini App** → тот же URL — тогда аппка получит короткую ссылку `t.me/ВашБот/app`

Готово. Напишите боту `/start` — придёт кнопка «Открыть конструктор».

## Админ-команды (работают только с вашего ADMIN_ID)

| Команда | Что делает |
|---|---|
| `/stats` | пользователи, песни, выручка, заявки на вывод |
| `/user <id>` | инфо о пользователе |
| `/give <id> <n>` | выдать n генераций |
| `/money <id> <n>` | начислить n грн на баланс |
| `/wd` | список заявок на вывод |
| `/wd_paid <id>` | отметить заявку выплаченной (юзер получит уведомление) |

## Что уже реальное, а что симуляция

- ✅ Реальное: регистрация по TG id, балансы в БД, рефералка (+1 ген за первую покупку реферала, 30% от покупок), **Telegram Stars** (пакеты и депозит), заявки на вывод с уведомлением админу, админ-команды.
- ⚠️ Симуляция (помечено `TODO` в server.js): оплата картой (нужен MonoPay/WayForPay мерчант), крипто-платежи (нужен процессинг типа Cryptomus/NOWPayments), сама ИИ-генерация музыки (следующий шаг — Suno API или аналог, подключается в `/api/song`).

**Важно до публичного запуска**: отключите демо-начисления — в `server.js` в эндпоинтах `/api/purchase` (card/crypto) и `/api/deposit` уберите начисление без реальной оплаты, иначе любой сможет пополняться бесплатно.

## Обновление кода

```bash
scp -r vps/* root@ВАШ_IP:/opt/yourmusic/
ssh root@ВАШ_IP 'systemctl restart yourmusic'
```

База данных — файл `/opt/yourmusic/data.db`. Бэкап: просто копируйте этот файл.
