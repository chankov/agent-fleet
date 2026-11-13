# Codex compatibility — required-subset catalog readiness (дял 7)

Потребителят прие дял 6 и изрично разреши тази catalog readiness промяна по D4. Identity,
queue version pins, human approval/authority gates не се разхлабват. Няма live операции,
активация или whole-plan opt-in; следва user gate.

## Факти и рутинни решения

- Реалният `McpProtocol.handle` в `scripts/lib/fleet-codex-local-mcp.ts` винаги предлага
  `2025-06-18`; diagnostics на същия server също връща тази ревизия. Той е собствен dispatcher,
  не SDK protocol negotiation. Затова explicit allowlist съдържа **само `2025-06-18`**.
  По-широкият SDK `SUPPORTED_PROTOCOL_VERSIONS` не е доказателство за поддържан от Fleet
  protocol. Не разрешаваме speculative ревизии и не променяме negotiation/diagnostics.
- Installed SDK `shared/toolNameValidation.js` (SEP-986) определя валидни case-sensitive
  имена: `[A-Za-z0-9._-]`, дължина 1–128. Това е основанието за valid additional names;
  няма нов SDK import в pure validator. Бюджетът остава максимум 128 tool entries.
- Required names не се променят: strict current profile изисква 28 (вкл. `fleet_response_read`).
  Extra valid names са игнорирани за feature requirements и не се извикват/упълномощават.
  Missing required, invalid entries, duplicates, over-limit, unknown identity/protocol отказват.
- Explicit legacy notification-only mode остава: 24 без connection markers; 27 при connection
  family без full-read; 28 при `fleet_response_read`. Marker за по-силен profile не допуска
  downgrade при partial/missing tools. Extra unrelated names не сменят profile по count.
- Import-free leaf `harnesses/lib/fleet-codex-catalog.ts` е единствената реализация; старият
  notification module re-export-ва API, а local MCP assessment е strict wrapper със
  `sourceCount=TOOLS.length`. Legacy режим продължава да се ползва само от стария preview.
  Първият MCP regression run хвана недопустим broad notification import в dispatcher-а.
  Вместо да го разрешаваме, изнесохме тесен leaf и добавихме точно него към dependency guard,
  с допълнителна проверка, че leaf няма static/re-export/dynamic imports. TOOLS, negotiation,
  handler dispatcher, права/leases и approval format остават неизменени.
- Materialize sparse arrays и приемаме само object entries с own string name. Това е
  fail-closed input validation, не проверка на реален host или произход на model claim.

## Проверки и риск

Умерен риск: променя се catalog readiness за valid additions, включително explicit legacy
preview profiles; това не е нова notification активация. Старите exact queue tuple, identity,
opt-in, owner/authority/expiry/mapping gates са запазени и synthetic тест ги проверява.
Изходното `ready` остава само catalog/preview резултат; не attestation или права.

След leaf extraction:
- **12/12** catalog теста (11 нови + разширен стар), плюс **20/20** existing runtime suite
  (19 стари + 1 нов fake-host constructor/no-implicit-start тест). И двата файла са в CI.
  Старият runtime parity тест вече проверява required subset и общите decisions, без да
  налага source/required count равенство при бъдещ optional tool; значенията им са запазени.
- **183/183** целеви теста в десет файла; **120/120** catalog + existing MCP tests
  (12 + 108). Тези suites се припокриват и не се сумират като независим общ брой.
- **900/900** `npm test` = 47 bounded + 853 parallel, 109 focused files, без fail/skip.
- Strict TypeScript за leaf, notification validator, local MCP source и catalog test.
- Expanded standalone strict check на целия legacy MCP test намира три readonly-fixture
  грешки на непроменените сегашни редове 573–574. Compiler-host проверка на оригиналния
  `HEAD` test със същите dependencies възпроизвежда същите три (оригинални редове 570–571,
  TS2339/TS2540). Не са regression и не са „поправени“ чрез несвързан fixture refactor.
- Manifest check: актуален, 103 items. Новият leaf се копира от съществуващото shared-lib tree;
  няма нов command/item/permission. `git diff --check` минава.
- Red→green proof: isolated VM върху оригиналния `HEAD` assessor отказва два valid additions
  случая (`fleet_future_tool`, `fleet_future_tool_v2`), които новият приема; без I/O от този код.
- Patch changeset `fleet-catalog-required-subset.md`, защото тази промяна вече е user-visible
  catalog bug fix (за разлика от предходните inert helpers). Няма version bump/staging/commit.

## Независим source review и остатъчни граници

Три разрешени read-only native scout reviews, без потвърден дефект:
- `hub-scout-81cf64d9-1a12-49c4-86e8-718a921d6ee0`: целият leaf/validation module, local MCP
  до ред 260, canonical catalog docs 115–144. Частичен: тестовете само grep excerpts, останалите
  source ranges/runner/evidence не са прегледани. Private override файлът липсва в snapshot;
  parent е прочел реалния файл и е спазил main/no-git-writes ограниченията.
- `hub-scout-9b21c3eb-82e1-458b-b6ef-ea67a52d82d3`: пълен 12-test catalog suite, dependency
  guard 292–305, diagnostics/initialize 330–405, runner 1–125, catalog evidence, README 1–75,
  и leaf. Parent провери по **девет** SHA-256 snapshot/current съвпадения, включително untracked
  leaf/test/evidence. След това caller inspection намери exact-source equality assertion в
  existing runtime suite; съгласуването му със subset договора и новият constructor тест/CI
  registration са прегледани отделно:
- `hub-scout-a163f0a8-dfe5-45e1-8d1a-3ad7455a1578`: runtime test 1–45, runner 34–48, leaf
  1–35 и strict wrapper 110–120; няма потвърден дефект. Parent провери **осем** snapshot hashes
  на всички final implementation/test/runner/canonical-doc файлове. Main implementation
  е непроменена след първите две reviews; новите runtime/CI assertions са покрити от третото.

Parent AST сравнение потвърди byte-identical `desktopQueuePin`, tuple list, matcher,
`notificationPreview`, `TOOLS`, `LocalCodexMcp`, `McpProtocol`, плюс четирите преместени required
name declarations. Patch changeset е парснат с локалния Changesets parser. Explicit whitespace
checks включват и untracked source/metadata. Финалният README tail, този review/results appendix
и patch changeset са metadata-only промени, проверени от parent, не отделно source-reviewed.

Reviewers **не са изпълнявали независимо тестове**, нито валидирали жив host. Тестовете са
операторски; accepted flow не е task acceptance. Няма реален Codex/socket/queue/probe или
нова compatibility admission wiring; production profile/qualified hashes/live Desktop evidence
липсват. Phase 0 и Phase 1 остават частични.

Потребителят прие дял 7 с „Одобрявам — продължи“ и разреши дял 8: пълен offline used-surface
profile и reference/мутационни fixtures, без нови qualified fingerprints, runtime admission
или live операции. Няма whole-plan opt-in; следващият user gate остава задължителен.
