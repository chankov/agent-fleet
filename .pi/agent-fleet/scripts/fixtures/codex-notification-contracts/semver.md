# Codex compatibility — независим semver дял (Фаза 1.1)

Това е само чистата version-prefilter логика от Фаза 1.1. Отворените измервания от
[Фаза 0](README.md#остава-във-фаза-0) остават незавършени. Този дял не зависи от отговора
на Desktop consumer/wake въпросите и **не** обявява Фаза 0 или цялата Фаза 1 за готова.
Работи се на `main`, без staging/commit според вече приетото решение.

## Обхват, риск и решения

- Нов shared pure модул: `.pi/harnesses/lib/codex-compat.ts`. Няма imports, I/O, clock,
  environment, мрежа, socket discovery, daemon start, config write, UI или runtime wiring.
- Нисък текущ риск: новата логика се използва само от тестове. Има бъдещ admission риск
  при интеграцията, затова не се допуска `eligible` да означава `compatible`/`verified`.
- Няма default minimum или готов production denylist. Policy се подава **изрично** от
  бъдещия caller като инертни JSON данни `{minimum, denylist}`. Версии в тестовете са
  fixtures, не нови pins.
- Използва се SemVer 2.0 precedence с ASCII prerelease identifiers. Не се преизползва
  Pi-specific comparator-ът от `context-continuity-compat.ts`: той умишлено допуска само
  plain numeric Pi releases и няма нужната prerelease семантика. Няма нов npm dependency.
- Numeric core/prerelease identifiers се сравняват по дължина и ASCII, не чрез `Number`,
  за да няма загуба на precision над `Number.MAX_SAFE_INTEGER`.
- Build metadata се валидира, но не влияе на precedence. Denylist използва същото SemVer
  равенство: добавяне/смяна на `+build` не заобикаля забранена версия. Prerelease е значим.
- Входът е ограничен до 256 ASCII символа на версия и 128 denylist entries. Невалидна или
  прекомерна policy/entry отказва целия prefilter; няма trim/coercion/banner/UA extraction,
  ranges, wildcards, implied defaults или скрит upper-major ceiling. Ограниченията са
  локална обратима защита за бъдещи config входове, не нова product support гаранция.
- Тестът е добавен в `bin/test/run-fast.js`, за да се изпълнява от `npm test` и release CI.
  Shared lib е част от съществуващия copy-tree companion; не е нужен нов manifest item.

## Вътрешен договор

`compareCodexVersions(left, right)` връща `-1 | 0 | 1 | undefined`; последното означава
невалиден вход, **не** равенство. Приема само реални SemVer version полета, не CLI output,
`v` prefix или initialize UA. Caller-ът ще трябва отделно да измери/извлече версиите.

`assessCodexVersion(observed, policy)` връща `{eligible, reason}`:

| reason | eligible | Значение |
| --- | --- | --- |
| `invalid_policy` | false | Липсващ/невалиден minimum/denylist, излишни JSON policy keys или невалидна entry |
| `invalid_version` | false | Observed версията не е валиден ограничен SemVer |
| `denied_version` | false | Съвпада със забранена release/prerelease версия, без значение от build metadata |
| `below_minimum` | false | Валидна е, но е под изричния minimum |
| `meets_minimum` | true | Минала е **само version prefilter-а** |

Редът е: проверка на **цялата** policy → observed version → denylist → inclusive minimum.
Дори по-ранна matching deny entry не скрива по-късна невалидна entry. Policy/input не се
мутират. Version eligibility не установява daemon/Desktop identity, socket epoch, contract
projection, loaded consumer, catalog, mapping, grant, lease, probe или човешко потвърждение.

Договорът е за инертни JSON данни (например от `JSON.parse`), не за произволни JavaScript
обекти. Getters/Proxy traps могат да хвърлят; модулът **не** обещава `never throws` за тях.
Symbol/non-enumerable свойства и странични свойства по масив не са част от JSON договора
и не се валидират като общ JavaScript object модел. Бъдещият caller трябва да подава JSON
данни или да третира неочаквано изключение като блокер, **никога** като разрешение/fallback.

`matchesDesktopQueueTuple`, `notificationPreview` и реалният delivery path са непроменени.
Новите `0.167.x` схеми/версии не получават admission само защото semver prefilter-ът е готов.
Не е активирано известие и не е извършена live queue/thread проба.

## Acceptance и проверки

11 нови теста проверяват:
- canonical SemVer prerelease реда за всички двойки; Codex alpha numeric компоненти;
- core/prerelease числа над safe integer precision; ASCII и prefix наредба;
- inclusive minimum, prerelease floor, бъдещи major версии без имплицитна support гаранция;
- denylist и невъзможност за build-metadata bypass;
- invalid version/policy, sparse denylist, липсващи/излишни keys, граници на размерите;
- неизменяемост, frozen inputs и детерминизъм.

Първо тестът е пуснат без имплементацията и отказва с `ERR_MODULE_NOT_FOUND` (очакван red).
След имплементацията петте целеви файла минават **92/92**, включително старите contract,
exact-tuple, catalog и desktop-queue регресии:

```sh
node --experimental-strip-types --test \
  .pi/harnesses/lib/codex-compat.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-notification-contract.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-event-compatibility.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-catalog-readiness.test.ts \
  .pi/agent-fleet/scripts/fleet-codex-desktop-queue.test.ts
```

Strict TypeScript `--noEmit` за модула **и** теста минава. `npm run check:manifest` минава
с непроменени 103 items. `npm test` минава **808/808** (47 bounded-integration + 761 parallel
теста, без fail/skip). Двата fast-lane етапа се броят заедно, не само последният summary.
Coms Code Reviewer независимо потвърди 92/92 целеви теста, двата fast-lane етапа (808 общо),
strict TypeScript и manifest check. Няма блокиращи находки. Реакция на двете бележки:
- Премахнати са неверният коментар за JS `$` и излишната full-match проверка. Проверено е
  с Node: без `m` regex-ът вече изисква край на входа; newline regression тестът остава.
- Уточнен е JSON input договорът и липсата на blanket exception-catching за exotic JS
  обекти. Това е ограничение за бъдещата интеграция, не нов runtime fallback.

Докладът `01M7570XFDDCA5FCBQX8NKZ8GE` е възстановен от reviewer pane-а при диагностика на
изтеклия Coms reply budget. След поправките отново минават 92/92 целеви и 808/808 fast теста,
strict TypeScript, manifest и whitespace/newline проверките.

Старото допълнително focused ревю `01M757H7240QACQ77SAF1GRHB0` остана без доклад след
два await периода; не се брои за проведено. Потребителят поиска нов опит, вместо затваряне
само с първото ревю. Актуалният human-scoped Coms pool вече предостави `code-reviewer2`.

**Новото независимо ревю `01M759R973XQ4B75S2DX24PW3A` е проведено: няма блокиращи находки.**
Докладът е възстановен от pane `wA:p82` при диагностика на изтеклия reply bridge budget.
Reviewer-ът прочете текущия код след поправките и независимо изпълни:
- 11/11 semver теста; strict TypeScript за модула и теста;
- 20 000 сравнителни случайни двойки спрямо наличния `semver@7.8.5`: без разминавания
  в избрания малък numeric/prerelease/build домейн (не е доказателство за всички входове);
- допълнителни JSON policy/denylist/size проби, manifest и whitespace check.
Този reviewer не е пускал целия 92/808 набор; той е повторен от оператора след поправките.
Единствената LOW бележка е била остарелият pending текст тук — с този запис е адресирана.
Няма останали блокиращи findings. Потребителят изрично прие дяла с „Одобрявам — продължи
със следващия дял“. Няма staging/commit. Следващият одобрен обхват е
[offline projection/fingerprint](projection.md).

## Следващ обхват

Извън semver дяла са projection/fingerprint, daemon schema measurement, нов approval формат,
`assessQueueCompatibility`, catalog subset промяна, bootstrap, TUI и live activation.
Projection kernel-ът вече е отделният одобрен [дял 3](projection.md); останалите части
изискват собствените си fixtures/мутации и оставащите проверки от плана. При бъдещото
runtime свързване `eligible: true` е необходимо само за новата compatibility пътека,
**никога достатъчно**. Старият exact-tuple път трябва да запази обратната съвместимост.
Changeset-ът остава за планираната интегрирана functionality, не за този unused internal дял.
