# 1C Retail NOC Dashboard — Мониторинг кассовых узлов и инцидентов

Профессиональный внутренний веб-сервис для проактивного мониторинга сети кассовых узлов «1С:Предприятие 8.3» в ритейле. Обеспечивает мгновенное выявление кассовых сбоев (фискальные накопители, сканеры, эквайринг, зависания транзакций), быстрый удаленный доступ (AnyDesk / RuDesktop), интеллектуальную диагностику причин ошибок (AI-Triage), ролевое разделение прав (RBAC) и сквозной журнал аудита действий дежурной смены.

---

## Архитектура системы

```
┌────────────────────────────────────────────────────────┐
│               Кассовый узел (POS)                      │
│  - 1С:Розница / УТ / РМК (платформа 8.3.14+)           │
│  - Стелс-расширение: support.cfe                       │
│  - Тихий опрос раз в 10 минут (фоновое задание)        │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS POST /api/v1/telemetry
                            │ (Bearer Token, gzip JSON, < 64 КБ)
                            ▼
┌────────────────────────────────────────────────────────┐
│             NOC Сервер (Next.js 15+)                   │
│  - API Route Handlers (защита rate-limiter, JWT HMAC)  │
│  - Интеллектуальный AI-Triage (Gemini Flash API)       │
│  - Локальное хранилище: SQLite (WAL-режим)             │
│  - Аутентификация, RBAC (ADMIN / ENGINEER), Аудит      │
└───────────────────────────┬────────────────────────────┘
                            │ Web UI (Linear / GitHub Dark)
                            ▼
┌────────────────────────────────────────────────────────┐
│         Рабочее место инженера техподдержки            │
│  - Лента активных сбоев и архив инцидентов за 14 дней  │
│  - Подключение к AnyDesk / RuDesktop в 1 клик          │
│  - Досье магазина с историей сбоев                     │
│  - Сервисная пауза опроса сети (Kill Switch)           │
│  - Журнал аудита действий смены                        │
└────────────────────────────────────────────────────────┘
```

---

## 1. Конфигурация переменных окружения (`.env`)

Создайте файл `.env` в корневом каталоге проекта на основе следующей спецификации:

| Переменная | Обязательна | По умолчанию в dev | Описание и назначение |
|---|---|---|---|
| `TELEMETRY_BEARER_TOKEN` | **Да** | `dev-secret-token-2026` | Секретный токен авторизации касс. Должен совпадать с токеном в расширении 1С и `install.bat`. |
| `DASHBOARD_USERNAME` | Нет | `admin` | Логин суперпользователя по умолчанию для первой инициализации. |
| `DASHBOARD_PASSWORD` | Нет | `admin` | Пароль суперпользователя по умолчанию для первой инициализации. |
| `SESSION_SECRET` | **Да** (в проде) | `noc-dashboard-session-secret...` | Соль для криптографической подписи HMAC-SHA256 сессионных кук. |
| `GEMINI_API_KEY` | Нет | — | Ключ Google Gemini API для автодиагностики и рекомендаций AI-Triage. |
| `APP_URL` | Нет | `http://localhost:3000` | Внешний базовый URL дашборда (используется для генерации ссылок). |

### Разница между `.env.local` и `.env.production`
* **`.env.local`** (локальная разработка): содержит тестовые токены, работает на `http://localhost:3000`. Ошибки SQLite пишутся в локальный `storage.db`.
* **`.env.production`** (боевой VPS): содержит сгенерированный 64-символьный `TELEMETRY_BEARER_TOKEN`, надежный криптографический `SESSION_SECRET` и боевой ключ `GEMINI_API_KEY`.

---

## 2. Управление доступом и роли (RBAC)

В системе реализовано строгое ролевое разделение:

1. **`ADMIN` (Администратор / Руководитель NOC):**
   * Полный доступ ко всем функциям мониторинга.
   * Доступ к **сервисной паузе опроса сети** («Пауза опроса сети» / Kill Switch), переводящей кассы в спящий режим на 24 часа.
   * Просмотр журнала аудита.
2. **`ENGINEER` (Дежурный специалист поддержки):**
   * Просмотр сбоев, запуск AnyDesk/RuDesktop, копирование паролей.
   * Закрытие инцидентов («Починено») и возобновление («Вернуть в работу»).
   * Кнопка сервисной паузы сети **заблокирована** (отображается как неактивная с подсказкой «Доступно только администраторам»).

### Учетные записи по умолчанию
При первом запуске база данных автоматически создает две стартовые учетные записи (пароли хэшируются SHA-256):
* **Администратор:** логин `admin`, пароль `admin` (роль `ADMIN`).
* **Инженер:** логин `engineer`, пароль `engineer` (роль `ENGINEER`).

### Добавление новых пользователей через CLI
Для добавления или смены пароля сотрудников используйте служебный CLI-скрипт:

```bash
# Синтаксис:
node scripts/create-user.mjs <username> <password> [ADMIN|ENGINEER]

# Примеры:
node scripts/create-user.mjs ivan pass123 ENGINEER
node scripts/create-user.mjs supervisor SuperSecure2026! ADMIN
```

### Журнал аудита (`audit_logs`)
Все ключевые события смены автоматически фиксируются в таблице `audit_logs`:
* Вход в систему (логин, роль).
* Закрытие сбоя (номер сбоя, автор `resolved_by`).
* Возобновление сбоя в работу.
* Включение/выключение паузы опроса сети.

В веб-интерфейсе просмотр доступен по кнопке **«Журнал»** в шапке дашборда.

---

## 3. Руководство по развертыванию на боевой сервер (Production VPS)

### Системные требования
* **ОС:** Ubuntu 22.04 LTS или 24.04 LTS (любой российский хостинг: Selectel, Timeweb Cloud, Cloud.ru, Beget).
* **Ресурсы:** 1 vCPU, 1–2 GB RAM, 20 GB SSD.
* **Сеть:** Статический публичный IPv4-адрес, открытые входящие порты `80` (HTTP) и `443` (HTTPS).

---

### Шаг 1. Первоначальная настройка сервера

Подключитесь к серверу по SSH и обновите пакеты:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw fail2ban
```

Настройте базовый файрвол:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

### Шаг 2. Установка Node.js 22 LTS и PM2

```bash
# Установка Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Проверка версий
node -v   # v22.x.x
npm -v

# Установка диспетчера процессов PM2
sudo npm install -g pm2
```

---

### Шаг 3. Клонирование репозитория и сборка

```bash
# Создание рабочей директории
sudo mkdir -p /var/www/noc-1c
sudo chown -R $USER:$USER /var/www/noc-1c

# Переход и клонирование/копирование кода
cd /var/www/noc-1c
git clone <URL_РЕПОЗИТОРИЯ> .

# Установка зависимостей
npm install

# Создание производственного конфигурационного файла
cat << 'EOF' > .env.production
NODE_ENV=production
TELEMETRY_BEARER_TOKEN="ваш_секретный_токен_касс_2026"
SESSION_SECRET="ваш_надежный_случайный_ключ_сессий_длиной_не_менее_32_символов"
DASHBOARD_USERNAME="admin"
DASHBOARD_PASSWORD="admin_change_me_immediately"
GEMINI_API_KEY=""
EOF

# Сборка проекта
npm run build
```

---

### Шаг 4. Настройка автозапуска через PM2

Создайте файл `ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    {
      name: 'noc-1c-dashboard',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: '/var/www/noc-1c',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      exp_backoff_restart_delay: 100,
      max_memory_restart: '800M',
    },
  ],
};
```

Запуск и сохранение в systemd:
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# Выполните команду, которую сгенерирует PM2 (sudo env PATH=... pm2 startup systemd ...)
```

---

### Шаг 5. Настройка Nginx и лимита запросов

Установите Nginx:
```bash
sudo apt install -y nginx
```

Создайте конфигурационный файл виртуального хоста `/etc/nginx/sites-available/noc-1c`:
```nginx
# Ограничение частоты запросов с касс
limit_req_zone $binary_remote_addr zone=telemetry_limit:10m rate=10r/s;

server {
    server_name noc.yourcompany.ru;

    # Максимальный размер тела телеметрии (кассы передают до 30-50 КБ)
    client_max_body_size 64k;

    # Прямая быстрая раздача дистрибутивов (install.bat, support.cfe)
    location /downloads/ {
        alias /var/www/noc-1c/public/downloads/;
        expires 1h;
        add_header Cache-Control "public, no-transform";
        try_files $uri =404;
    }

    # Эндпоинт приема телеметрии касс
    location /api/v1/telemetry {
        limit_req zone=telemetry_limit burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Все остальные маршруты (веб-интерфейс дашборда)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    listen 80;
}
```

Активируйте сайт и проверьте конфигурацию:
```bash
sudo ln -sf /etc/nginx/sites-available/noc-1c /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

### Шаг 6. Выпуск бесплатного SSL-сертификата (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d noc.yourcompany.ru
```
Certbot автоматически перенаправит HTTP на HTTPS и настроит автопродление сертификата.

---

### Шаг 7. Резервное копирование SQLite базы данных

Поскольку SQLite работает в режиме WAL, онлайн-бэкап базы данных выполняется безопасной утилитой `sqlite3`:

```bash
sudo apt install -y sqlite3
sudo mkdir -p /var/backups/noc-1c
```

Создайте скрипт бэкапа `/var/www/noc-1c/scripts/backup.sh`:
```bash
#!/usr/bin/env bash
set -e
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="/var/backups/noc-1c"
DB_SRC="/var/www/noc-1c/storage.db"
BACKUP_DST="$BACKUP_DIR/storage_$TIMESTAMP.db"

# Безопасный снимок базы без остановки работы сервиса
sqlite3 "$DB_SRC" ".backup '$BACKUP_DST'"

# Сжатие gzip
gzip -f "$BACKUP_DST"

# Удаление копий старше 14 дней
find "$BACKUP_DIR" -type f -name "storage_*.db.gz" -mtime +14 -delete
```

Сделайте скрипт исполняемым и добавьте в Cron:
```bash
chmod +x /var/www/noc-1c/scripts/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /var/www/noc-1c/scripts/backup.sh > /dev/null 2>&1") | crontab -
```

---

## 4. Развертывание на стороне клиентов (Магазины)

### Сборка расширения `support.cfe`
1. Откройте любую типовую базу «1С:Предприятие 8.3» в режиме **Конфигуратор**.
2. В меню выберите: `Конфигурация` → `Расширения конфигурации` → `Добавить`.
3. Установите имя расширения: `_МС_Поддержка` (синоним: `Мониторинг сети 1С`).
4. Назначение: `Дополнение`. Область действия: `Информационная база`.
5. Снимите флажки «Безопасный режим» и «Защита от опасных действий».
6. Перенесите код из папки `1c/extension/`:
   * `МодульУправляемогоПриложения.bsl` (стелс-запуск с отложенным стартом 5 сек).
   * `ОбщийМодуль._МС_Сервер.bsl` (сбор железа, сеансов, ошибок ЖР, AnyDesk и тихая отправка).
7. Сохраните конфигурацию и выгрузите расширение в файл `public/downloads/support.cfe`.

### Регламент установки на кассе за 30 секунд
На целевом кассовом терминале инженер техподдержки:
1. Запускает `cmd.exe` или `PowerShell` от имени Администратора.
2. Выполняет установку через заранее подготовленный пакетный скрипт:
   ```cmd
   curl -o %TEMP%\install.bat https://noc.yourcompany.ru/downloads/install.bat && %TEMP%\install.bat
   ```
3. Скрипт:
   * Проверяет права администратора.
   * Проверяет и закрывает монопольные процессы 1С (`1cv8.exe`).
   * Находит каталог информационной базы в `ibases.v8i`.
   * Тихо подключает `support.cfe` через пакетный режим Конфигуратора:
     `/LoadCfg -Extension "_МС_Поддержка" /UpdateDBCfg`.
   * Проверяет наличие установленного AnyDesk/RuDesktop.
   * Делает тестовый запрос и сообщает об успешном подключении.
4. В веб-панели магазина касса появляется со статусом **«На связи»**.

---

## 5. Чеклист готовности к запуску (Pre-flight Checklist)

- [ ] Сервер развернут на защищенном HTTPS-домене.
- [ ] Порт `3000` закрыт файрволом и доступен только через Nginx.
- [ ] В `.env.production` изменены стандартные пароли `admin` и сгенерирован уникальный `SESSION_SECRET`.
- [ ] Настроен ежедневный бэкап базы данных в `/var/backups/noc-1c`.
- [ ] Файл `support.cfe` проверен и доступен по адресу `https://noc.yourcompany.ru/downloads/support.cfe`.
- [ ] Тестовая касса подключена, статус отображается в реестре без задержек интерфейса у кассира.
