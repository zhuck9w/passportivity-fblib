# Ad Library Search MVP

Локальный MVP для сбора объявлений конкурентов из Facebook Ad Library и просмотра их редакцией.

## Что уже есть

- Playwright-скрейпер с конфигом селекторов в `config/selectors.json`.
- Два независимых backend-инстанса: интерфейсный API (`http://localhost:4000`) и сервис скрейпера (`http://localhost:4001`).
- React/Vite дашборд на `http://localhost:5173`.
- Supabase schema в `sql/schema.sql`.
- Управление конкурентами: Page ID, название, включение/выключение сбора, скрытие объявлений из выдачи (иконка «глаз»).
- Массовое добавление конкурентов списком в формате `Название, ID, заметка` (по одному на строку, заметка необязательна).
- Запуск сбора по всем включенным конкурентам или по одному конкуренту.
- Остановка running-сбора с сохранением уже успешно собранных объявлений.
- Сохранение объявлений, вариаций, гео-видимости и HTML-превью.
- Каждое объявление сохраняется отдельной строкой по `facebook_library_id`; текстовые дубли не склеиваются.
- Новые креативы считаются `NEW` с первого сбора: и при вставке ранее не виденного объявления, и при первом полном скане конкурента.
- Переключатель порядка строк в тулбаре: «По компаниям» (как собрано) / «NEW сверху» (все новые первыми, независимо от компании). Если новых нет — порядок не меняется.
- Фильтр по конкурентам — мультивыбор с чекбоксами, поиском внутри списка и кнопками «Выбрать все» / «Сбросить».
- Все фильтры (конкуренты, статус, поиск, сортировка) запоминаются в localStorage и переживают перезапуск сервера/браузера.
- Мобильный вид: в шапке остаются только «Конкуренты» и «Собрать включенных», статистика и фильтры убраны в бургер-меню — таблица занимает почти весь экран.
- AI-анализ креативов (OpenAI vision): 8 колонок `ai_*` с разбором объекта, цвета, JTBD, УТП, описания, хука, оффера и психологии.

## Архитектура (два бэкенда)

Backend разделён на два независимых процесса, интегрированных через общую Supabase (прямых HTTP-вызовов между ними нет):

- **Интерфейсный API** — `src/server/interface.ts`, порт `4000` (`PORT`).
  Конкуренты, объявления, гео, статистика прогонов. Только чтение/запись в БД, без Playwright — может жить на Vercel (serverless).
- **Сервис скрейпера** — `src/server/scraperService.ts`, порт `4001` (`SCRAPER_PORT`).
  Запуск/остановка/статус сбора + сам Playwright + менеджер задач + логи скрейпера. Это долгоживущий процесс (минуты на сбор, headed-браузер, persistent-профиль), поэтому деплоится на отдельный сервер с диском, не на Vercel.

Фронт ходит в оба бэкенда: всё, кроме сбора, — в интерфейсный API; `start/stop/статус` сбора — в сервис скрейпера (см. `VITE_API_URL` / `VITE_SCRAPER_URL` в `.env.example`). Скрейпер пишет собранные объявления в Supabase, интерфейсный API их оттуда отдаёт — поэтому после сбора дашборд просто перечитывает данные из БД.

Общий код (`repositories.ts`, `supabase.ts`, `env.ts`, `adStatusReconciliation.ts`, `shared/types.ts`) импортируют оба процесса из одного репозитория.

## AI-анализ креативов

После того как скрейпер сохранил объявление, сервис скрейпера автоматически анализирует креатив через OpenAI и пишет результат в 8 колонок таблицы `ads`:

`ai_main_object`, `ai_main_color`, `ai_jtbd`, `ai_utp`, `ai_description`, `ai_hook`, `ai_offer`, `ai_psychology` (+ служебная `ai_assessed_at`).

Как это работает (`src/server/aiAssessment.ts`):

- Ссылки на картинки берутся из `media_items` объявления — те же, что используются в превью (для видео — постер). Для каруселей берутся все слайды.
- Facebook CDN блокирует скачиватель OpenAI, поэтому скрейпер сам скачивает картинки по этим ссылкам и передаёт их в OpenAI как base64 (одним запросом, до 10 изображений).
- Карусель анализируется целиком одним запросом — модель даёт сводный разбор всей карусели, а не каждого слайда.
- Каждое поле — русский текст до 300 символов (обрезается жёстко).
- Видео-креативы не анализируются (постер ничего не говорит о сути видео): во все `ai_*`-поля пишется «Видео», ставится `ai_assessed_at`, запрос в OpenAI не делается.
- Анализ идёт в фоновой очереди и не замедляет сбор; в конце прогона статус показывает «Жду завершения AI-анализа креативов (N)».
- Повторно объявление не анализируется (пропуск по `ai_assessed_at`). Ошибка анализа не ломает сбор — пишется в `logs/scraper.log`.
- Жёсткий пересбор: `AI_ASSESSMENT_FORCE=true` в `.env` переанализирует и уже проанализированные объявления (нужно после смены `OPENAI_MODEL` или промптов). Флаг намеренно живёт только в `.env`, не в интерфейсе. После пересбора верните `false`, иначе каждый сбор будет заново платить за все креативы.

Промпты лежат в едином конфиге `config/aiPrompts.json` (system, шаблон задачи, заметка для каруселей и формулировки всех 8 полей) — правятся без изменения кода.

Настройка в `.env`: `OPENAI_KEY` (обязателен; без него анализ выключен), `OPENAI_MODEL` (по умолчанию `gpt-4o-mini`), `AI_ASSESSMENT_ENABLED=false` — выключатель.

Для теста на одном объявлении:

```powershell
curl.exe -X POST http://localhost:4001/api/scrape -H "Content-Type: application/json" -d "{\"limit\": 1}"
```

## Supabase

1. Откройте Supabase Dashboard.
2. Зайдите в проект.
3. Откройте `SQL Editor`.
4. Выполните SQL из `sql/schema.sql`. Скрипт идемпотентный — его безопасно прогонять повторно после обновлений (например, чтобы добавить колонку `competitors.visible` для скрытия объявлений из выдачи).
5. В `.env` должны быть:

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-secret-or-service-role-key
SCRAPER_HEADLESS=false
SCRAPER_BROWSER_CHANNEL=chrome
SCRAPER_USER_DATA_DIR=.playwright-profile
SCRAPER_SLOW_MO_MS=250
SCRAPER_LIMIT=25
SCRAPER_COLLECT_CAROUSELS=true
```

`SUPABASE_SECRET_KEY` желателен для backend-записи. В текущей локальной настройке также поддерживается имя `SECRET`. Если оставить только publishable key, запись будет работать только при разрешающих RLS/GRANT настройках из SQL.

`SCRAPER_HEADLESS=false` открывает видимое окно Chromium во время сбора. Чтобы вернуть фоновый режим, поставьте:

```env
SCRAPER_HEADLESS=true
SCRAPER_SLOW_MO_MS=0
```

После изменения `.env` перезапустите backend.

`SCRAPER_BROWSER_CHANNEL=chrome` запускает обычный установленный Google Chrome вместо bundled Chromium Playwright. Это полезно для Facebook Ad Library, потому что выдача может отличаться для разных браузеров/профилей.

`SCRAPER_USER_DATA_DIR=.playwright-profile` включает постоянный профиль браузера. В этой папке сохраняются cookies и вход в Facebook. Папка добавлена в `.gitignore`.

`SCRAPER_LIMIT=25` задает системный лимит успешно сохраненных объявлений на один запуск. Когда лимит достигнут, сбор закрывает браузер и завершается со статусом `succeeded`.

`SCRAPER_MAX_ADS` остается техническим лимитом карточек/скролла на конкурента. Обычно достаточно держать `SCRAPER_LIMIT` и `SCRAPER_MAX_ADS` одинаковыми.

`SCRAPER_COLLECT_CAROUSELS=true` включает проход по горизонтальным каруселям (`data-type="hscroll-child"`) и сохранение каждого слайда в `media_items`. Если нужно временно ускорить сбор или проверить старое поведение, поставьте `false`.

Сбор по умолчанию идет только по текущим активным объявлениям Facebook Ad Library:

```text
active_status=active
```

Если база уже была создана старым `schema.sql`, выполните актуальный `sql/schema.sql` повторно в Supabase SQL Editor. Это обновит constraint для статуса `stopped`.

## Запуск

Первичная установка:

```bash
npm install
npx playwright install chromium
```

Если PowerShell ругается на `npm.ps1`, используйте Windows-обертку:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

После разделения бэка запускаются **три** процесса: интерфейсный API, сервис скрейпера и фронт.

Всё одной командой (рекомендуется):

```powershell
npm.cmd run dev
```

Поднимутся сразу три процесса (вывод помечен префиксами `interface` / `scraper` / `client`):

```text
http://localhost:4000   интерфейсный API   (npm run dev:interface)
http://localhost:4001   сервис скрейпера   (npm run dev:scraper)
http://localhost:5173   дашборд            (npm run dev:client)
```

Каждый процесс можно поднять отдельно (например, в разных терминалах):

```powershell
npm.cmd run dev:interface   # интерфейсный API на :4000
npm.cmd run dev:scraper     # сервис скрейпера на :4001 (нужен для запуска сбора)
npm.cmd run dev:client      # фронт на :5173
```

Только оба бэкенда, без фронта:

```powershell
npm.cmd run dev:backend
```

Для просмотра с телефона используйте production-сборку фронта — dev-режим React заметно медленнее на слабых устройствах:

```powershell
npm.cmd run build
npm.cmd run preview   # прод-фронт на http://<IP-компьютера>:4173, API проксируется как в dev
```

Проверка здоровья:

```text
http://localhost:4000/api/health   -> { "service": "interface", ... }
http://localhost:4001/api/health   -> { "service": "scraper", ... }
```

Дашборд работает и без запущенного скрейпера (показывает уже собранные данные из Supabase), но кнопки «Собрать»/«Остановить» требуют живого сервиса скрейпера на `:4001`.

Остановить процессы на текущих портах:

```powershell
Get-NetTCPConnection -LocalPort 4000,4001,5173 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Открыть:

```text
http://localhost:5173
```

Остановить текущий сбор можно кнопкой `Остановить` в дашборде или API-запросом к сервису скрейпера:

```powershell
curl.exe -X POST http://localhost:4001/api/jobs/<run_id>/stop
```

## Facebook login profile

Facebook Ad Library может показывать меньше активных объявлений анонимному Playwright Chromium, чем обычному Chrome с вашим входом. Для полной выдачи используйте persistent profile.

В `.env` должны быть:

```env
SCRAPER_HEADLESS=false
SCRAPER_BROWSER_CHANNEL=chrome
SCRAPER_USER_DATA_DIR=.playwright-profile
```

Один раз откройте браузер для логина:

```powershell
npm.cmd run login:facebook
```

В открывшемся Chrome войдите в Facebook/Meta и убедитесь, что Ad Library показывает полную выдачу. После этого вернитесь в терминал и нажмите Enter. Cookies сохранятся в `.playwright-profile`, и следующие запуски скрейпера будут использовать этот же профиль.

Важно: не запускайте одновременно `login:facebook` и сбор. Один persistent profile должен использоваться одним процессом браузера.

## Логи

При запуске через фоновые команды в корне проекта остаются:

- `server.log` — вывод backend-процесса.
- `client.log` — вывод Vite/frontend.

Подробный ход сбора пишется сюда:

- `logs/scraper.log`
- `logs/server.log`

Смотреть последние строки можно в PowerShell:

```powershell
Get-Content .\logs\scraper.log -Tail 80 -Wait
```

Или через API сервиса скрейпера:

```text
http://localhost:4001/api/logs/scraper?lines=80
```

## Селекторы

Все DOM-селекторы лежат в `config/selectors.json`. После проверки на реальной странице Meta лучше заменить дефолтные широкие селекторы на более точные:

- `results.adCard`
- `results.infoButton`
- `group.variationCard`
- `detail.previewContainer`
- `detail.locationToggle`
- `detail.locationRows`
- `detail.locationCells`

Главный контейнер превью уже задан как:

```json
".ad-library-dynamic-content-container"
```

## Скрипт сбора без UI

Собрать всех включенных:

```bash
npm run scrape
```

Собрать одного конкурента:

```bash
npm run scrape -- --competitor=<uuid из Supabase> --limit=10
```

Отключить сбор каруселей для разового CLI-запуска:

```bash
npm run scrape -- --no-carousels
```

## Проверки

```bash
npm test
npm run build
```

## Ограничения MVP

- Facebook-логин поддерживается через локальный persistent profile Playwright. Капчи и обход ограничений не реализуются.
- Медиа не скачиваются отдельно; сохраняется HTML финального превью.
- Селекторы Meta нужно будет уточнить на живой странице, если текущие широкие кандидаты цепляют лишние контейнеры.
- Перед переносом на Vercel нужно заменить MVP RLS policies на приватную auth-модель.
