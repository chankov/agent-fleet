# Codex compatibility — offline projection/fingerprint (дял 3)

След изрично одобрение на semver дяла е реализиран следващият независим дял от Фаза 1,
т.2. **Фаза 0 остава отворена**; няма нов runtime admission, bootstrap или live проба.

## Обхват, риск и технически решения

- Нов `.pi/harnesses/lib/codex-contract.ts`, отделно от вече прегледания semver модул.
  Единственият import е deterministic SHA256 от `node:crypto`; няма filesystem, socket,
  environment, clock, мрежа, изпълнение на binary или schema код.
- Текущият риск е ограничен до unused internal логика и offline тестове. Бъдещото свързване
  към admission е рисковата граница: fingerprint **не** е identity/probe/authority доказателство.
- `projectSchema(documents, usedSurface)` приема вече прочетени инертни JSON schema обекти
  по file name, **не** чете directory. I/O loader-ът, binary/daemon version matching,
  timeout, byte limits на експорта и socket epoch са отделната Фаза 1, т.3.
- `usedSurface` е изричен caller contract: име/file/direction и shape с `type`, `fields`,
  `items`, `variant {field,value}`, `literal`, request `sent` или response `optional`.
  [Дял 8b](opaque-response.md) добавя explicit `{type:'opaque'}` само за required response
  property с direct schema `true`: presence marker, не JSON type/payload guarantee. Други
  schema forms/controls, request/root/items/optional opaque selection се отказват.
  Shape-ът и имената на roots участват в `surfaceKey`; различен consumer contract не може
  да се сравни като същата surface. Не се извеждат гаранции от schema filenames сами по себе си.
- Ограничен resolver, не общ JSON Schema engine: local escaped JSON Pointer `$ref`,
  singleton `allOf`, request `anyOf` с един branch, който приема всички изпращани типове,
  и disjoint tagged `oneOf`. [Дял 8a](response-unions.md) добавя само bounded response `anyOf`
  с 1–5 disjoint single-primitive-type branches; integer/number overlap, nested/general/object
  unions и literal selectors се отказват. Branch assertions се пазят отделно, освен при
  unconstrained union (existing flat type-set representation). Сложен `allOf`, external/cyclic
  refs, променящи reference scope `$id`/anchors, неизвестен draft/used assertion се отказват.
  Неизползваните tagged payload-и се игнорират само след проверка на discriminator-а;
  wildcard/двусмислен tag не минава като additive промяна.
- Поддържаните assertion values се запазват; промяна на ограниченията се сравнява
  консервативно, дори ако човек може да докаже, че е безвредна. Няма общ subtype theorem
  prover, regex execution, schema download или нова npm зависимост.
- Annotation metadata и неизползвани fields/variants не влизат в projection-а. `default`
  се запазва; ключове/enum/type/required sets са канонизирани. Не се мутират входове и
  резултатът не задържа mutable aliases към тях.
- Локални bounds: 32 roots, 256 set/union/enum entries, depth 64, 4096 schema steps,
  8192 canonical nodes и 1 MiB сумарни canonical string/key characters. Това ограничава
  projection-а, **не замества byte limit-а при бъдещото четене на целия export**.

## Проверки по посока

**Request:** избраните полета трябва да са декларирани. Ограниченото изключение
[open sent empty-object property](open-sent.md) допуска known empty-object template само за
недекларирано поле в guaranteed `sent`, при parent additionalProperties absent/strict true.
Декларирана schema винаги се проверява; scalar/array/nested templates и general boolean
schemas остават unsupported. Parent constraints/requiredness не се заобикалят.
Known empty sent array е explicit request `literal:[]` (без `items` selector): пази array
assertions/enum/const, отказва minItems>0 и не измисля непращани items. Nonempty/sparse/object/
response literals и general schema:true не се добавят. Вж. [current profile](profile.md).
Схемата трябва да приема всички изпращани типове; всяко required поле трябва да е в `sent`
(по подразбиране всички избрани полета). Нов required, който действително винаги изпращаме,
не е счупване. Нов required,
който може да пропуснем, се отказва. Text variant-ът и неговият избран dependency graph
се проверяват след local ref resolution; нови disjoint audio/video branches не го променят.

**Response:** избраните типове трябва да са в рамките на това, което consumer-ът обработва.
Избраните полета остават required, освен изрично декларираните `optional`. Полето трябва да
съществува в schema дори когато е optional при runtime. Нови response fields/required entries
извън used surface са безопасни. Retained `notLoaded` tagged branch е задължителен, но това
не е твърдение, че живият thread наистина е в това състояние.

`ContractProjectionError` носи code/path при отказ. Това е offline fail-closed отказ за
измерен schema export, не нова runtime fallback политика. Exotic JS getters/Proxies не са
JSON input contract и няма обещание за blanket exception catching.

`compareProjection(known, observed)` отказва различен `surfaceKey` и всяка разлика в
нормализирания used contract. `fingerprint()` е SHA256 върху version-domain prefix + bounded
canonical JSON (`fleet-codex-projection/v1`); не включва whole-file schema hashes, transport
identity или доказателство за съвпадаща жива версия. Реалният comparator caller трябва да
ползва доверен, квалифициран known baseline, не два произволни caller-provided обекта.

## Измерен fixture и audited test surface

За да не се измислят липсващи embedded schema тела, offline capture selection е разширен
с точните ClientRequest definitions `UserInput`, `TextElement`, `ByteRange`, `ImageDetail`.
Fixture-ът е регенериран от **двата оригинални** temp exports `0.167.0` и `0.167.1`:
- двата пълни snapshots са равни;
- всичките 11 full-source hashes са непроменени;
- всяко предишно fragment значение е непроменено;
- новите embedded definitions са равни на standalone queue-add definitions в теста.

Тестовете реконструират **само** записаните fragments. Това е затвореният used подграф,
не възстановен пълен export или оригинален `0.166.0` fixture. `ThreadReadResponse` остава
metadata-only. ServerNotification payloads не се въвеждат от списъка с имена.

Audited test surface включва initialize и четирите queue/read метода (10 request/response
roots). Request envelopes/params се резолвват от **ClientRequest**, не се заменят с
самостоятелен params файл. Response roots идват от съответните response exports. Surface
следва прочетените `codex-unix-queue-rpc.ts` / `codex-desktop-queue-host.ts`:
- initialize clientInfo/experimentalApi и userAgent;
- read threadId/includeTurns и response thread.id/status.notLoaded;
- queue add text/input/clientUserMessageId и receipt id/echo;
- queue list pagination и submission fields;
- loaded-list default empty params, data и optional nextCursor.

Loaded-list bootstrap pager още не е реализиран: полетата му не се обявяват за изпращани.
При бъдеща промяна на caller payload-а surface трябва да се одитира/версионира отново.
Няма production `usedSurface` конфигурация или списък с нови verified fingerprints.
`initialized` client notification, JSON-RPC/error envelopes и останалите notification
payload-и **не** са покрити от тези 10 тестови roots. Това е изричен prerequisite за
production профила/интеграцията, а не твърдение за проверен целия wire protocol.

## Acceptance и резултати

13 нови теста, включени във fast/release-CI lane:
- deterministic canonical fingerprint, field/union/required order и ref renaming;
- additive optional request fields, response additions и disjoint audio/video variants;
- remove/rename method/field, unsent required param, missing text/notLoaded variant;
- response field requiredness и `queuedSubmission.id` type;
- conservative constraint changes, malformed assertions/surface;
- external/missing/cyclic refs, unsupported drafts/scopes/compositions, resource limits;
- frozen inputs, no mutation и detached output.

Първият fixture run откри traversal на неизползвания image `anyOf`; поправено е discriminator
сканирането да проверява disjoint tags преди payload traversal. След поправката:
- **105/105** в шестте целеви файла (projection + semver + четирите предходни contract/runtime suites);
- **821/821** `npm test`: 47 bounded-integration + 774 parallel, без fail/skip;
- strict TypeScript за модула, теста и capture helper-а; `npm run check:manifest` (103 items);
- `git diff --check`.

При финално повторение един `npm test` опит достигна outer tool timeout от 120 секунди
без финален parallel summary и без отчетен assertion fail; той **не** се брои за успешен.
Повтореният пълен run с 300-секунден outer budget приключи за около 17 секунди: отново
47 + 774 = **821/821**, без fail/skip. Вътрешните тестови timeout-и не са променяни;
не е установена причина за междинното забавяне и не е правен unrelated test fix.

Потребителят изрично разреши вграден read-only агент вместо Coms, след като Coms pool-ът
стана празен. Първи scout review: `hub-scout-6f1a5192-1770-45c5-af50-3f1210192d6a`.
Агентът прочете кода, теста, fixture/capture, CI и документацията; няма потвърден kernel
дефект, но не изпълнява commands/тестове и не можеше сам да провери hash-овете.
Операторът разреши integrity ограничението чрез native `snapshot-manifest.json`: шестте
заявени file hashes съвпадат точно с текущите файлове, включително untracked новите модули.
Coverage бележката за `initialized` notification е адресирана с изричното ограничение по-горе.
Фокусираното adversarial повторно ревю `hub-scout-d5f35f91-f600-4b89-8501-9eada52bf36d`
също не потвърди дефект: прегледани са request/response requiredness/types, disjoint-tag proof,
ref/draft guards, constraint retention, canonicalization, bounds и detached output. Операторът
провери и втория native snapshot manifest: шестте review file hashes съвпадат с текущото дърво.
Това е независимо source-only ревю, **не** изпълнение/fuzzing на тестове от scout; пълният
fixture и test execution не са независимо проверявани от втория агент. Тестовите резултати
105/821 са от реалното изпълнение на оператора, а не от scout report-а.
Дялът е готов за user review gate, не е приет автоматично от FLOW ACCEPTED банера.
Работната база е `9b40ff9c`; remote main междувременно е с 2 commits напред. Няма pull/merge
или други git-state промени; доказателствата са за провереното текущо дърво. Няма staging/commit, config/grant/lease промени или
активация. Фаза 1 остава частична: липсват measurement wiring, compatibility assessment и
catalog subset промяната. Историческите exact tuples са непроменени.
