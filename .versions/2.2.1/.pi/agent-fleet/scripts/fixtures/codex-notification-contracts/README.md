# Codex notification contract — Фаза 0, инкремент 1

Следващите primitives са описани отделно: [bootstrap core](bootstrap.md),
[локален ACK reader](probe-reader.md), [изричен CAS reconnect](reconnect.md),
[bootstrap path profile](bootstrap-profile.md) и [duplex channel](channel.md). Вече има guarded production service/root/UI integration и synthetic runtime tests; това не е Desktop qualification, live разрешение или текуща активация. Фаза0 остава частична. Виж [текущия workflow и отделно разрешен preflight](../../../../../docs/codex-notification-bootstrap.md).

`bootstrap-profile-0.167.json` е и изрично публикуван/инсталиран **неквалифициран runtime reference** за server-owned policy, не runtime capture или доверен qualified fingerprint. Следващите capture/risk/evidence секции описват историческия offline increment, не пълния текущ feature scope.

Измерване: 2026-11-11. Това е **частична Фаза 0**, не нов runtime gate и не доказателство
за Desktop доставка. Предходната response-read работа е в `dfe571b1`. По изрично решение
на потребителя работата остава на `main`, без staging/commit, въпреки старото изискване
за отделен branch в локалния план.

## Обхват и риск

Нисък риск за този инкремент: само offline capture helper, fixtures и тестове. Няма промени
по production код, настройки, права, notification активация или протоколни allowlist-и.
Helper-ът не изпълнява binary, не отваря socket, не стартира daemon и не връща compatibility
решение. Той приема вече прочетени schema байтове (`Uint8Array`/`Buffer`), hash-ва ги
директно и декодира JSON със strict UTF-8 (без заместване на невалидни байтове). BOM също
участва в hash-а. Тестовете са изцяло offline.

Evidence е тук, а не в `docs/plans/`, защото плановете са gitignored. `0.167-shared.json`
е общ fixture за **два отделно измерени** локални Linux binary експорта, чиито 11 избрани
source файла са byte-for-byte еднакви. SHA-256 покрива **целите оригинални source файлове**,
а fragments пазят без нормализация само избраните JSON Pointer стойности. Hash-овете не
са hash-ове на fragments и не са нови production pins.

`capture.ts` запазва:
- initialize request/capabilities/clientInfo и initialize response schema;
- envelopes и вградените params definitions на `thread/read`, `thread/loaded/list`,
  `thread/queue/add`, `thread/queue/list`; първият дял сравнява само горното ниво на params.
  В projection дяла capture е разширен с точните embedded `UserInput`/`TextElement`/
  `ByteRange`/`ImageDetail`; отделен тест сравнява и тези definitions със standalone
  схемата. Всички full-source hashes и предишни fragments са запазени непроменени;
- `thread/read` params и metadata response полетата `id`/`status`, включително `notLoaded`;
- целите queue add/list и loaded-list params/responses, включително text union варианта,
  `clientUserMessageId`, `queuedSubmission.id`, `input`, `nextCursor`;
- имената на експортираните server notifications (наблюдение, **не** ignore allowlist).

Fragments с `$ref` остават относителни към **своя оригинален source файл**. Това не е
самостоятелен валидируем JSON Schema bundle и не е projection/fingerprint от Фаза 1.
Особено `ThreadReadResponse` е умишлено частичен: без turns, item payload-и или transcript.
Queue union-ът включва и audio като evidence; capture **не** го обявява за съвместим и
не разширява text-only transport-а.

Pointer helper-ът е умишлено ограничен до фиксираните root/object-key пътища от
`contractSelections`: няма escaped `~0`/`~1` tokens или array-index traversal. Той не е
общ JSON Pointer resolver. `/oneOf` обработката е изрична само за ClientRequest и
ServerNotification; друг source с такъв selector се отказва, вместо тихо да губи payload.

## Измерени факти

`measurements.json` записва binary версии, platform и SHA-256, както и sanitize-натите
резултати от две read-only операции върху вече работещия daemon:

1. `codex app-server daemon version`: CLI/managed binary/app server са `0.167.1`.
2. Една WS-over-Unix `initialize` заявка с bridge clientInfo и `experimentalApi: true`.
   Връзката е прекратена веднага след отговора. `userAgent` е
   `Codex Desktop/0.167.1 (Ubuntu 25.10.0; x86_64) dumb (agent_fleet_queue_bridge; 1)`.
   Запазени са само UA и имената на result полетата; стойността на `codexHome` е изключена.

**Извод:** UA съдържа версията, но надписът `Codex Desktop` се връща и от daemon control
socket-а. Той **не** доказва Desktop executable, UI сесия, MCP `clientInfo` или loaded consumer.
Експорт от binary със същата версия като този daemon е възможен тук. Това само по себе си
не решава дали D6 е необходим на други хостове или за bundled Desktop binary.

Историческите три кортежа в `measurements.json` са копие на текущия exact gate, **не ново
измерване**. Източници:
- `.pi/harnesses/lib/fleet-notification-validation.ts`;
- `.pi/agent-fleet/scripts/fleet-codex-event-compatibility.test.ts`;
- `docs/plans/2026-0-archive/evidence/damage-control-codex-relay-20261106-root-audit/e4-desktop-preflight-20261107/`
  (`schema-hashes.txt`, `RUNBOOK.md`, `DESKTOP-COMPATIBILITY.diff`; локален архив, gitignored).

Липсващите стари binary/schema тела не са измислени от hash-овете. Новите schema hash-ове
съвпадат с вече записаните queue hashes за Desktop `0.167.0-alpha.3.2`, но това **не** прави
нов daemon/Desktop tuple допустим. Регресионен тест проверява точно тази граница.

## Възпроизводим offline capture

Експортира се от конкретния вече наличен binary, без download/install или daemon start.
Използвай отделна temp директория за всяка версия. За измерените binaries:

```sh
base="$HOME/.codex/packages/standalone/releases"
scratch=$(mktemp -d /tmp/fleet-codex-contract-XXXXXX)
for version in 0.167.0 0.167.1; do
  binary="$base/$version-x86_64-unknown-linux-musl/bin/codex"
  "$binary" --version
  sha256sum "$binary"
  "$binary" app-server generate-json-schema --experimental --out "$scratch/$version"
done
export CODEX_CONTRACT_EXPORT_ROOT="$scratch"
```

Сравнение с checked-in fixture, от repo root, без презаписване на evidence:

```sh
node --experimental-strip-types --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {captureNotificationContract,contractSelections} from './.pi/agent-fleet/scripts/fixtures/codex-notification-contracts/capture.ts';
const expected = JSON.parse(readFileSync('.pi/agent-fleet/scripts/fixtures/codex-notification-contracts/0.167-shared.json', 'utf8'));
for (const version of ['0.167.0', '0.167.1']) {
  const sources = Object.fromEntries(Object.keys(contractSelections).map(file => [
    file, readFileSync(join(process.env.CODEX_CONTRACT_EXPORT_ROOT, version, file)),
  ]));
  assert.deepEqual(captureNotificationContract(sources), expected);
  console.log(version + ': exact snapshot and full-source hashes match');
}
JS
```

Умишлено няма автоматична жива initialize/probe команда в helper-а. Статичните тестове не
използват локално инсталиран Codex или истински host socket. Synthetic reconstruction тестът
проверява extractor-а, **не** претендира да възстановява оригиналните bytes от fragments.

## Acceptance за този инкремент

- Двата независими локални schema експорта възпроизвеждат exact snapshot + source hashes.
- Capture отказва липсващ source/fragment, счупен JSON и променен/липсващ/дублиран method union.
- Fixture пази използваните metadata/text queue полета; трите стари exact tuples остават
  допустими, а новите версии **не** се приемат само заради еднакви offline схеми.
- Без runtime/UI/permissions/config промени, live queue add, thread read/resume или probe.

Проверка:

```sh
node --experimental-strip-types --test \
  .pi/agent-fleet/scripts/fleet-codex-notification-contract.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-event-compatibility.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-catalog-readiness.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-desktop-queue.test.ts
```

Финални проверки след поправките:
- **81/81** целеви теста (включително 10 нови contract теста).
- **797/797** от повторен `npm test`: 47 bounded-integration + 750 parallel теста;
  отделна suite, не замества целевите тестове. По-ранният запис „750“ броеше само
  последната фаза; уточнението е проверено срещу запазения log от първия инкремент.
- TypeScript `--noEmit` проверка на capture helper-а; `git diff --check` и отделна
  whitespace/newline проверка на петте нови файла (още не са staged).
- `npm run check:manifest`: manifest-ът е актуален (103 items).
- Snapshot-ът е регенериран от двата оригинални exports след добавянето на embedded params;
  deep equality покрива fragments и всички пълни source hashes.

Coms Code Reviewer независимо потвърди първоначалното възпроизвеждане и 79/79 теста;
няма блокиращи находки. Реакция на находките:
- **M1:** тестът вече закрепва равенството с историческите Desktop hashes, променя по една
  версия на известен допустим tuple и отказва hypothetical fresh pairs с **пълни** schema
  доказателства за двата endpoint-а. Не претендира, че е измерен Desktop consumer.
- **L1:** запазени са и четирите embedded request params definitions; тестът сравнява
  само горното ниво със standalone схемите при първото ревю. Тогава не се твърди сравнение
  на referenced dependencies; последващият projection дял вече записва/сравнява и четирите
  нужни embedded definitions, без да представя нови данни като старо измерване.
- **L2:** документиран е ограниченият pointer subset; не е добавян общ resolver.
- **L3:** hash-ват се сурови bytes; отделен тест за BOM и отказ на невалиден UTF-8.
- **L4:** notification обработката вече е обвързана изрично с ServerNotification source.
- **L5:** всеки негативен method-union тест очаква точния собствен error message.

**Повторно Coms ревю:** потвърдени са поправките по M1/L1–L5, reproduction с raw bytes,
81/81 теста и strict TypeScript проверка. **Няма блокиращи находки.** Единствената останала
нискорискова бележка е за referenced dependency definitions от L1; избран е предложеният
от reviewer-а вариант да се документира точно частичното покритие, без разширяване на този дял.
Двата доклада са възстановени от reviewer pane-а след timeout на reply bridge-а
(`01M754RV98AN0ZEHWRYEVPZN3P`, `01M755G9FYR4C31DBR827RWBPK`).
Това завършва този частичен инкремент, **не** целия план или цялата Фаза 0.

## Остава във Фаза 0

- Оригиналните schema exports за `0.166.0` и трите исторически Desktop alpha версии, ако
  binaries са налични; иначе изрично недостъпно evidence, не синтетичен „измерен“ fixture.
- Desktop executable identity и MCP clientInfo от реален consumer, отделно от daemon UA.
- `thread/read includeTurns:true` върху конкретно одобрен `notLoaded` thread: има ли последен
  assistant ACK без loading. Тук не е четен transcript и не е избран произволен чужд чат.
- Отваряне на чат със събитие, чакащо в опашката, изисква live queue write/consumer проба;
  отложено е, не е отчетено като „невъзможно“. Не е извършвана Фаза 5.

Бележки от ревюто за следващия обхват (не нови гаранции): при consumer/projection работата
да се оценят `ThreadReadResponse.readState`, `Thread.canAcceptDirectInput` и payload schemas
на `thread/queue/changed` / `thread/status/changed`. Сега не се консумират от capture/runtime
договора. Export-ите включват и `codex_app_server_protocol.schemas.json` /
`codex_app_server_protocol.v2.schemas.json`; Фаза 1 може да използва тези bundles вместо
частични source fragments. Raw export-ите са
в temp директория и не са трайно evidence; възпроизводимите команди и binary hashes са тук.

Докато тези въпроси са неизмерени, **Фаза 0 остава незавършена**. Projection,
`assessQueueCompatibility`, bootstrap, TUI и новата активация са следващи инкременти, не част
от тази промяна. Няма нужда от changeset за този test/evidence-only дял.

## Следващ независим инкремент

[Semver foundation (Фаза 1.1)](semver.md) добавя само pure comparison/minimum/denylist логика
и offline тестове, без production wiring. Той е приет от потребителя след реалното повторно
Coms ревю. [Projection/fingerprint (дял 3)](projection.md) също е приет от потребителя.
[Measurement/export helpers (дял 4)](measurement.md) са приети след source reviews и проверки.
[Connect-only observer adapter (дял 5)](observer.md) е приет след fake IPC проверки и source
reviews, без реален daemon. [Pure assessment (дял 6)](assessment.md) е приет, без runtime
admission, нова approval форма или активация. Разрешеният [catalog readiness (дял 7)](catalog.md)
приема required subset + valid additions с explicit protocol allowlist; 183/183 целеви,
120/120 catalog+MCP и 900/900 fast тестове са зелени (suites се припокриват). Source-only
reviews не потвърдиха дефект; не са изпълнявали независимо тестовете. Дял 7 е приет;
разрешен е дял 8: offline used-surface profile + fixtures, без нови qualified fingerprints,
runtime admission/live операции. Identity/queue pins/human authority gates са неизменени.
[Дял 8 inventory](surface.md) възпроизведе три kernel предпоставки за пълен envelope profile.
Разрешеният отделно [дял 8a](response-unions.md) покрива само primitive response-anyOf;
297/297 targeted и 906/906 fast са зелени. Два source-only reviews не потвърдиха дефект;
не са изпълнявали независимо тестовете. Дял 8a е приет. Разрешеният отделно
[дял 8b](opaque-response.md) добавя само required opaque response presence за schema true;
303/303 targeted и 912/912 fast са зелени; source-only review без потвърден дефект и без
независимо изпълнени тестове. Дял 8b е приет. След status/checkpoint/manual compaction gate
потребителят написа „продължи“ за отделния [дял 8c](open-sent.md): само open sent empty-object
request property, без general boolean/schema engine. 309/309 targeted и 918/918 fast са
зелени; source-only review няма потвърден дефект и не е изпълнявал тестовете. Шест snapshot
hashes са проверени. 8c е приет. По изрично ново указание продължаваме между фазите без
междинни одобрения, с вътрешни reviews; material decisions/live permissions не са отменени.
[Current profile](profile.md) покрива12roots/8files, възпроизведен от двата offline exports
без нов qualified tuple. Има known empty-array literal/strict runtime guards/nine-root exporter.
[Bootstrap coordinator core](bootstrap.md) е synthetic-tested, още не production/UI wiring.
Фази0/1 са partial; actual Desktop/probe evidence липсва и live разрешение няма.
Тези подзадачи не изискват отговорите на отворените live въпроси и не променят
acceptance/prerequisites за останалата Фаза 1. Фаза 0 остава отворена.
