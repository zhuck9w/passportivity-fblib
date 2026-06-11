# Ad Library Search MVP

Локальный MVP для сбора объявлений конкурентов из Facebook Ad Library и просмотра их редакцией.

## Что уже есть

- Playwright-скрейпер с конфигом селекторов в `config/selectors.json`.
- Локальный Express API на `http://localhost:4000`.
- React/Vite дашборд на `http://localhost:5173`.
- Supabase schema в `sql/schema.sql`.
- Управление конкурентами: Page ID, название, включение/выключение сбора, скрытие объявлений из выдачи (иконка «глаз»).
- Массовое добавление конкурентов списком в формате `Название, ID, заметка` (по одному на строку, заметка необязательна).
- Запуск сбора по всем включенным конкурентам или по одному конкуренту.
- Остановка running-сбора с сохранением уже успешно собранных объявлений.
- Сохранение объявлений, вариаций, гео-видимости и HTML-превью.
- Каждое объявление сохраняется отдельной строкой по `facebook_library_id`; текстовые дубли не склеиваются.

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

Запустить backend отдельно:

```powershell
npm.cmd run dev:server
```

Backend будет доступен здесь:

```text
http://localhost:4000
http://localhost:4000/api/health
```

Запустить frontend отдельно во втором терминале:

```powershell
npm.cmd run dev:client
```

Frontend будет доступен здесь:

```text
http://localhost:5173
```

Запустить backend и frontend одной командой:

```powershell
npm.cmd run dev
```

Остановить процессы на текущих портах:

```powershell
Get-NetTCPConnection -LocalPort 4000,5173 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Открыть:

```text
http://localhost:5173
```

API:

```text
http://localhost:4000/api/health
```

Остановить текущий сбор можно кнопкой `Остановить` в дашборде или API-запросом:

```powershell
curl.exe -X POST http://localhost:4000/api/jobs/<run_id>/stop
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

Или через API:

```text
http://localhost:4000/api/logs/scraper?lines=80
```

В дашборде справа также есть блок `Журнал`.

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
