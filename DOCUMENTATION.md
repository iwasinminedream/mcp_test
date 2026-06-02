# dota2-mcp — Документация

MCP-сервер для моддинга Dota 2 (Source 2). Даёт Claude (или любому MCP-клиенту)
точные пути к ассетам, attachment-points моделей, ссылки и граф зависимостей
партиклов/материалов, генерацию корректного Lua для привязки партиклов, превью
текстур/экспорт моделей и поиск по Dota 2 API. Цель — **никогда не ошибаться в
именах ассетов и сигнатурах API**.

- **Платформа:** Windows x64, **Node 20+**, установленная Steam-версия Dota 2.
- **Транспорт:** stdio (стандартный MCP).
- **Зависимости рантайма:** `@modelcontextprotocol/sdk`, `zod`, `pngjs`.
- **Внешний инструмент:** `Source2Viewer-CLI` (ValveResourceFormat) — для
  декомпиляции `_c` (партиклы/материалы/текстуры/модели). Поиск по индексу и
  attachment-имена работают и без него; декомпиляция/превью/экспорт — требуют его.

---

## 1. Быстрый старт

### Разработка из исходников
```powershell
npm install
npm run build         # tsc -> dist/
npm run smoke         # демонстрация индекса/поиска без MCP-клиента
```

### Регистрация в Claude Code
В проекте есть `.mcp.json` (project scope) — Claude Code предложит подтвердить
сервер при старте сессии в этой папке. Либо явно:
```powershell
claude mcp add dota2-mcp -- node "C:\Users\Admin\Documents\project\mcp_test\dist\server.js"
```
Затем перезапустить Claude Code и проверить через `/mcp`.

### Раздача другим пользователям (самодостаточный пакет)
```powershell
npm run package
```
Создаёт `release/dota2-mcp/` и `release/dota2-mcp.zip` (~50 МБ), внутри:
`server.mjs` (весь сервер одним файлом, `node_modules` не нужен),
`vendor/Source2Viewer-CLI/` (декомпилятор + DLL), `vendor/dota-data/` +
`vendor/moddota-articles/` (API JSON + статьи), `install.ps1`, `package.json`,
`README.md`, `NOTICE.txt`. Получателю нужны только **Node 20+** и Steam-копия
Dota 2: распаковать → `./install.ps1`.

---

## 2. Конфигурация (переменные окружения)

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `DOTA_PATH` | Папка `…\dota 2 beta\game`. | Автодетект через Steam `libraryfolders.vdf`, иначе стандартный путь. |
| `ADDON_PATH` | Явный путь к открытому аддону (проект или его namespace-корень). | — |
| `S2V_CLI` | Путь к `Source2Viewer-CLI.exe`. | `vendor/Source2Viewer-CLI/`, иначе dev-путь. |
| `DOTA_DATA_PATH` | Папка `files/` пакета `@moddota/dota-data` (API + игровые KV + локализация). | `vendor/dota-data/`, иначе sibling-репозиторий. |
| `DOTA_DATA_LANGS` | Языки локализации для вендоринга (через запятую). Только для `npm run vendor-data`. | `english,russian`. |
| `VPK_CACHE_TTL_MS` | TTL эфемерного кэша декомпиляции. | `600000` (10 мин). |
| `EXPORT_DIR` | Куда `export_model` кладёт glTF/GLB (постоянно). | `%TEMP%\dota2-mcp\exports`. |
| `CONSOLE_LOG` | Путь к `console.log` Dota 2. | `<game>\dota\console.log`. |
| `ADDON_WATCH` | `0` — выключить авто-слежение за ассетами аддона. | вкл. |
| `ADDON_WATCH_DEBOUNCE_MS` | Дебаунс вотчера, мс. | `400`. |
| `LOG` | `0` — выключить лог активности сервера. | вкл. |
| `LOG_FILE` | Путь к файлу лога активности. | `<корень>\logs\dota2-mcp.log`. |
| `LOG_MAX_BYTES` | Порог ротации лога. | `5 МБ`. |

**Активный аддон.** Индексируется **только один** — текущий открытый. Резолв по
порядку: `ADDON_PATH` → `CLAUDE_PROJECT_DIR` (Claude Code ставит его на открытый
проект) → cwd. Сервер находит namespace-корень аддона (папку с подпапками
`particles/`, `models/`, `materials/`, …). Учитывается типичный лейаут, где
`<project>/game` — **симлинк** на `…\dota 2 beta\game\dota_addons\<name>`. Loose-
файлы аддона перекрывают базовые ассеты при совпадении пути и участвуют в поиске,
интроспекции и графе. Если аддон не открыт — индексируются только базовые VPK.

Пример: сервер запущен в `C:\Users\Admin\Documents\project\rda_game` → директорией
аддона станет `…\rda_game\game` (симлинк на `…\game\dota_addons\rda_game`), источник
в индексе — `addon:rda_game`. Проверить — `index_status.addons` (поля `source`,
`dir`, `via`).

**Live-watch.** Папка активного аддона отслеживается (`src/loose/watcher.ts`):
изменения **скомпилированных ассетов** (`*_c`) инкрементально и только по аддону
обновляют индекс и граф (дебаунс). `scripts/` и прочий не-ассетный шум
игнорируются. Выключается `ADDON_WATCH=0`.

> Примечание про `scripts/`: файлы скриптов (Lua/KV/cfg) **индексируются только
> для поиска путей** (удобно найти `npc_heroes.txt` и т.п.) и НИКОГДА не попадают
> в граф зависимостей и не вызывают его пересборку — это касается и стартового
> индекса, и live-watch.

---

## 3. Инструменты (29)

### Поиск и разрешение имён (мгновенно, без CLI)
| Инструмент | Вход | Результат |
|---|---|---|
| `find_assets` | `query` (подстрока или glob с `*`), `kind?`, `limit`, `offset` | пути ассетов (пагинация) |
| `resolve_asset` | `name` (с опечатками), `kind?`, `limit` | ближайшие реальные пути + score (фаззи) |
| `list_dir` | `prefix` | под-папки и файлы под префиксом |
| `stat_asset` | `path` | метаданные (размер, архив/источник, crc32); при промахе — фаззи-подсказки |

### Интроспекция (через Source2Viewer-CLI, эфемерный кэш)
| Инструмент | Вход | Результат |
|---|---|---|
| `model_info` | `path .vmdl_c` | **attachment-points** (`attach_*`) + ссылки (материалы/субмодели/партиклы), помеченные как существующие/отсутствующие |
| `particle_info` | `path .vpcf_c` | дочерние `.vpcf`, классы функций, `m_nMaxParticles`, control points, ссылки |
| `material_info` | `path .vmat_c` | шейдер + текстурные ссылки |
| `decompile` | `path`, `offset?`, `limit?` | KV3-текст любого `_c` (пагинация по символам) |

### Граф зависимостей + привязка партиклов
| Инструмент | Вход | Результат |
|---|---|---|
| `refs_from` | `path` | исходящие зависимости (что ассет ссылается) |
| `refs_to` | `path`, `limit` | обратные зависимости (кто ссылается — «что сломается при переименовании X») |
| `build_graph` | `force` | принудительная пересборка графа (обычно строится лениво и кэшируется) |
| `validate_attachment` | `model`, `attachment`, `particle?` | проверка существования модели/партикла/attachment-имени + реальный список attachment'ов и фаззи-подсказки |
| `gen_attach_snippet` | `model`, `attachment`, `particle`, `controlPoint?`, `attachType?`, `entityVar?` | готовый корректный Lua: `CreateParticle` + `SetParticleControlEnt` |

### Конвертация
| Инструмент | Вход | Результат |
|---|---|---|
| `preview_texture` | `path .vtex_c`, `maxDim?` | инлайн-PNG (даунскейл), временный файл удаляется сразу |
| `export_model` | `path .vmdl_c`, `format(glb\|gltf)`, `animations?`, `materials?` | glTF/GLB на диске (постоянно) + список файлов |

### Dota 2 API (готовые дампы @moddota/dota-data)
| Инструмент | Вход | Результат |
|---|---|---|
| `api_search` | `query`, `domain?`, `kind?`, `limit` | символы API с сигнатурой/классом/доступностью |
| `api_get` | `name`, `domain?`, `class?` | полная карточка: сигнатура (args+types+returns), значение константы, члены enum, поля события. Методы — `Class:method` или просто имя; instance-глобалы (`ParticleManager:…`) резолвятся |
| `api_class` | `name` | класс с собственными **и унаследованными** (по `extend`) методами |
| `css_prop` | `name` | декларация Panorama CSS-свойства (описание + примеры) из `panorama/css.json`; при промахе — фаззи-подсказки |

> Туториалы ModDota (`docs_search`/`docs_get`) намеренно **удалены** — они часто
> устаревшие и могут вводить в заблуждение. Источник истины по API — машинные
> дампы `@moddota/dota-data` (генерируются из самой игры).

### Игровые KeyValues + локализация (дампы @moddota/dota-data)
| Инструмент | Вход | Результат |
|---|---|---|
| `ability_kv` | `name`, `resolveBase?` | **реальные KV способности** из `abilities.json` (`AbilityBehavior`, cast range/point, cooldown, mana, `AbilityValues`/спец-значения) + герой-владелец (`ability-hero-map`) + локализованные имя/описание; при промахе — фаззи-подсказки |
| `hero_kv` | `name`, `resolveBase?` | реальные KV героя из `heroes.json` (Model, атрибуты, урон/броня, скорость, `Ability1..N`) + список способностей + локализованное имя |
| `unit_kv` | `name`, `resolveBase?` | реальные KV юнита из `units.json` + список способностей + локализованное имя |
| `localize` | `key`, `lang?`, `limit?` | строка локализации по ключу (терпит ведущий `#`) из `localization/<язык>.json`; при промахе — подсказки по подстроке ключа. Язык по умолчанию `english` (вендорится ещё `russian`) |

> `resolveBase` подмешивает неявный шаблон-базу (`ability_base` / `npc_dota_hero_base`
> / `npc_dota_units_base`) под запись. По умолчанию выключено — отдаются «сырые» KV.

### Консоль игры (ошибки «с момента» по байт-курсору)
| Инструмент | Вход | Результат |
|---|---|---|
| `console_mark` | — | `{path, exists, offset, size, mtimeMs, sig}` — снимок конца лога = «момент»; вызывать в начале задачи |
| `console_errors` | `since?`, `level?` (`error`/`warning`/`info`), `dedupe?`, `limit?` | читает **только дельту** с `since.offset`, классифицирует, склеивает Lua-трейсбеки, дедуплицирует с `count`, ловит ротацию; отдаёт `entries[]` + `newCursor` (передать как `since` в следующий раз). Без `since` берётся момент старта сервера |
| `console_tail` | `lines?` | последние N сырых строк лога |

### Сервис
| Инструмент | Результат |
|---|---|
| `index_status` | состояние: gameDir, пакеты, аддон, число ассетов, доступность CLI/графа/API, путь лога, статус вотчера |
| `server_log` | разбор лога активности: вызовы инструментов (newest-first), фильтры `errorsOnly`/`tool`/`level` |
| `reindex` | перестроить индекс после обновления Dota (+ форс-пересборка графа, переподключение вотчера) |

---

## 4. Архитектура

```
L4  MCP surface (src/server.ts) — 29 tools поверх stdio (@modelcontextprotocol/sdk)
                                  + фоновый warmup графа после connect
                                  + обёртка registerTool: тайминг/лог/catch (log.ts)
L3  Домен:
      introspect/{model,particle,material,decompile,references,attach}.ts
      graph/depGraph.ts        — прямой/обратный граф (RERL), кэш в JSON
      api/{apiData,apiIndex}.ts — поиск по Dota 2 API + CSS-декларации
      api/gameData.ts          — игровые KV (abilities/heroes/units) + локализация
      console/consoleLog.ts    — чтение console.log по байт-курсору
L2  Индекс/кэш:
      index/assetIndex.ts      — агрегатор источников, поиск, фаззи (fuzzy.ts)
      cache.ts                 — TTL-кэш + эфемерные temp-папки (auto-delete)
L1  Мосты:
      cli/decompiler.ts        — execFile → Source2Viewer-CLI (-d/-b/-a)
      cli/convert.ts           — текстура→PNG (pngjs), модель→glTF/GLB
L0  Источники ассетов (общий интерфейс AssetSource, vpk/source.ts):
      vpk/reader.ts (VpkArchive)   — свой парсер VPK v2
      loose/looseDir.ts (LooseDir) — loose-файлы аддона (симлинки/realpath)
      loose/watcher.ts             — live-watch аддона (только _c, инкрем. граф)
      vpk/resource.ts              — парсер заголовка Source 2 → RERL-блок
```

### Ключевые технические решения (проверены эмпирически)

- **Свой VPK v2 ридер** (`vpk/reader.ts`): npm-пакеты `vpk`/`vpk2` старые и без
  типов; нам нужно только дерево путей. Поддержаны split-архивы (`pak01_NNN.vpk`)
  и embedded-данные (`archiveIndex == 0x7FFF`). Число записей совпадает с
  `Source2Viewer-CLI --vpk_list` (371 482 в `game/dota`).

- **In-memory индекс**, без нативных зависимостей. Базовые VPK
  (`game/dota` + `game/core`) = **372 659** ассетов, строится ~0.7 с. Пути
  case-insensitive (как в движке); активный аддон добавляется первым и
  перекрывает базу при коллизии.

- **Мульти-источник** (`vpk/source.ts`): общий интерфейс `AssetSource`
  (`listEntries`/`readFull`/`readRange`/`id`) — `VpkArchive` и `LooseDir`
  обрабатываются одинаково во всём индексе, интроспекции и графе.

- **Attachment-имена моделей.** В `_c` блок `DATA` — это LZ4-сжатый бинарный KV3,
  поэтому raw-strings и `-b DATA` дают пусто. Имена достаются из `-a` (все блоки)
  регуляркой `attach_[a-z0-9_]+` (axe.vmdl_c → 7 attachment'ов).

- **Граф зависимостей без CLI.** Гонять декомпилятор по 127k файлов нельзя.
  Парсим заголовок Source 2 → таблицу блоков → читаем **только RERL-блок**
  (`vpk/resource.ts`, ~16 КБ на файл, не весь файл). Байт-в-байт совпадает с CLI
  (модель 5/5, партикл 2/2, материал 8/8). ~263k+ рёбер по ~127k файлов за
  считанные секунды, потом кэш в JSON (инвалидация по fingerprint индекса).
  У моделей RERL-блок в конце файла — поэтому нужен разбор заголовка, а не
  strings-scan.

- **Эфемерный кэш** (`cache.ts`): декомпиляция идёт в temp-папку и удаляется сразу
  после чтения («декомпилировал → прочитал → удалилось»); распарсенные результаты
  кэшируются в памяти по `crc32` (патч Dota → авто-инвалидация), TTL настраивается.

- **Инициализация при первом запуске (warmup).** Индекс VPK и API-дампы грузятся
  при старте (это быстро). Единственная ленивая дорогая часть — граф зависимостей.
  После `server.connect()` сервер запускает `warmup()` в фоне (`setTimeout(…,0).unref()`):
  граф либо мгновенно поднимается из disk-кэша (если версия Dota не менялась), либо
  строится один раз (~2–4 с). Сервер при этом сразу отвечает на запросы; к моменту
  первого `refs_from`/`refs_to`/`validate_attachment` граф обычно уже готов
  (`ensureGraph()` идемпотентен — если warmup ещё не закончил, первый вызов
  достроит синхронно). Итог: время ответа на любой запрос — минимальное.

- **Лог активности + защита вызовов** (`log.ts`). `server.registerTool`
  обёрнут: каждый вызов любого инструмента таймится и пишется одной JSONL-строкой
  в постоянный лог (`<корень>\logs\dota2-mcp.log`); брошенное в обработчике
  исключение **ловится** — пишется `level:"error"` со стеком, а клиенту
  возвращается аккуратный `isError`-результат (вызов не валит сервер). Также
  логируются `startup` и `uncaughtException`/`unhandledRejection`. Разбор —
  инструментом `server_log` (фильтры `errorsOnly`/`tool`/`level`, newest-first)
  или грепом JSONL. Лог ротируется (~5 МБ), отключается `LOG=0`.

- **Dota 2 API** (`api/*`): читает уже собранные JSON `@moddota/dota-data`
  (билд не нужен). Классы несут поле `instance` (например
  `CScriptParticleManager.instance = "ParticleManager"`), поэтому методы
  алиасятся под `<instance>:<member>` — `ParticleManager:CreateParticle`
  резолвится. `api_class` разворачивает цепочку наследования (`CDOTA_BaseNPC_Hero`
  → сотни унаследованных методов). Туториалы ModDota НЕ используются — только
  машинные дампы (они синхронны с текущей версией игры).

- **Консоль игры** (`console/consoleLog.ts`): лог `console.log` растёт до десятков
  МБ (49 МБ / 514k строк на момент разработки), поэтому читается только дельта по
  байт-курсору. `console_mark` фиксирует конец файла; `console_errors` читает
  байты с `since.offset` до EOF, парсит строки `MM/DD HH:MM:SS [Channel] msg`,
  классифицирует по каналам/паттернам (`Script Error`, `[VScript]`,
  `stack traceback`, `Cannot find`, `Failed to load`, `Assert`, `Warning`…),
  фильтрует шум (`GCClient`/`SteamNetSockets`/`RenderSystem`), склеивает
  многострочные Lua-трейсбеки в одну запись и дедуплицирует одинаковые сообщения
  с `count`. Ротация (файл уменьшился или сменилась сигнатура первых 64 байт) →
  перечитывание с нуля. На старте сервер делает авто-mark как fallback-«момент».

- **Доменный факт.** `.vpcf` НЕ хранит, к какой модели/attachment он привязан —
  привязка делается в рантайме (Lua `ParticleManager:CreateParticle` +
  `SetParticleControlEnt(fx, cp, ent, PATTACH_POINT_FOLLOW, "attach_…", origin, true)`).
  Имя attachment имеет смысл только для `PATTACH_POINT`/`PATTACH_POINT_FOLLOW`.
  Отсюда — `validate_attachment` и `gen_attach_snippet`.

---

## 5. Структура проекта

```
src/
  server.ts                    # точка входа, регистрация 29 инструментов + warmup
  log.ts                       # постоянный JSONL-лог вызовов + server_log/readLog
  config.ts                    # резолв Dota/аддона/CLI/API-данных, TTL
  indexer.ts                   # сборка индекса (аддон + базовые VPK)
  kinds.ts  fuzzy.ts  strings.ts cache.ts
  vpk/      source.ts reader.ts resource.ts
  loose/    looseDir.ts watcher.ts
  index/    assetIndex.ts
  cli/      decompiler.ts convert.ts
  introspect/ model.ts particle.ts material.ts decompile.ts references.ts attach.ts
  graph/    depGraph.ts
  api/      apiData.ts apiIndex.ts gameData.ts
  console/  consoleLog.ts
  # тесты-проверки:
  smoke.ts mcptest.ts m3test.ts m3mcptest.ts m4test.ts m5test.ts gametest.ts m6test.ts addontest.ts releasetest.ts
scripts/
  bundle.mjs      # esbuild → bundle/server.mjs (один файл)
  vendor-cli.mjs  # копирует Source2Viewer-CLI + DLL в vendor/
  vendor-data.mjs # копирует нужные dota-data JSON в vendor/ (API + игровые KV + локализация; DOTA_DATA_LANGS)
  package.mjs     # bundle + vendor-cli + vendor-data + zip → release/
```

---

## 6. npm-скрипты

| Скрипт | Что делает |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm run dev` | запуск сервера из исходников (`tsx src/server.ts`) |
| `npm run smoke` | демонстрация индекса/поиска без MCP-клиента |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run bundle` | esbuild → `bundle/server.mjs` |
| `npm run vendor-cli` | вендор декомпилятора |
| `npm run vendor-data` | вендор API JSON |
| `npm run package` | полный самодостаточный релиз (`release/dota2-mcp.zip`) |

---

## 7. Тестирование / верификация

Тесты — самостоятельные скрипты (через `npx tsx src/<name>.ts`), печатают вердикт
и кодом выхода сигналят PASS/FAIL:

- `mcptest.ts` — MCP round-trip (M1/M2 инструменты).
- `m3test.ts` / `m3mcptest.ts` — граф зависимостей + валидаторы/кодген.
- `m4test.ts` — превью текстуры (PNG) + экспорт модели (glb).
- `m5test.ts` — поиск по API, сигнатуры, наследование классов (+ что docs-инструментов нет).
- `gametest.ts` — `css_prop` + KV способностей/героев/юнитов + локализация (en/ru).
- `m6test.ts` — чтение console.log: классификация, дедуп, дельта по байт-курсору.
- `addontest.ts` — индексация активного аддона (запускать с `ADDON_PATH`).
- `releasetest.ts` — комплексная проверка **упакованного** `server.mjs`
  (аддон + M2 + M3 + M4 + M5), спавнит сервер из `release/`.

Эталоны для проверки: реальные VPK игры (`models/heroes/axe/axe.vmdl_c` имеет
`attach_attack1`/`attach_hitloc`); число записей ридера сверяется с
`Source2Viewer-CLI --vpk_list`. (Карта `miparena.vpk` для проверки имён базовых
ассетов не годится — там контент карты, не дерево игры.)

---

## 8. Статус и роадмап

**Готово (всё):** M0 каркас · M1 индекс/поиск/фаззи · M2 интроспекция · M3 граф +
валидация/кодген привязки · M4 конвертация · M5 поиск по Dota 2 API · CSS-декларации
(`css_prop`) + игровые KV (`ability_kv`/`hero_kv`/`unit_kv`) и локализация (`localize`) ·
M6 чтение `console.log` (ошибки «с момента» по байт-курсору) · индексация активного
аддона · warmup при старте. **29 инструментов.** Сборка и typecheck чистые; все
wire-тесты (M2–M6, gametest, addon, warmup) и упакованный релиз — PASS.

Аудит соответствия плану (2026-06-01): **все обязательные пункты M0–M6 и
индексация аддона реализованы как задумано** (0 расхождений в M1–M6). Из
опциональных «идей по улучшению» не сделаны два необязательных: скан строковых
ссылок вне RERL (Lua/конфиги) и каталог `npc_heroes → модель → дефолтные
партиклы`; patch-diff покрыт через fingerprint-инвалидацию (без активного скана
изменений). Туториалы ModDota удалены сознательно (устаревают, путают).

Возможные дальнейшие расширения (необязательные): live-режим консоли
(`fs.watch`), отправка команд через `-netconsole`, SQLite/FTS5 при росте
требований к поиску, две опциональные идеи выше.

---

## 9. Лицензии

Сервер использует `Source2Viewer-CLI` (ValveResourceFormat, MIT) и данные
`@moddota/dota-data` (Apache-2.0). См. `NOTICE.txt` в релизе. Это сторонние
инструменты Valve-сообщества; проект лишь вызывает их и читает их вывод.
