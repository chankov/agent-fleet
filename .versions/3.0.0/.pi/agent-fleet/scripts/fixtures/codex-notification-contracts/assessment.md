# Codex compatibility — version/schema preflight assessment (дял 6)

Потребителят прие дял 5 и разреши **чиста version/schema assessment логика**, без runtime
admission, approval формат или live операции. Няма whole-plan opt-in; следва user gate.

## Приет ограничен обхват / рутинни технически решения

Новата pure `assessQueueCompatibility(evidence, policy)` е preflight, **не ready/enable**.
Няма probe вход или изпълнение; всяко неблокирано ниво изисква бъдещ probe и отделните
human confirmation/consumer/owner/authority/freshness gates. Тези gates не могат да бъдат
заменени с classification level. Старият `notificationPreview`, exact tuple gate, approval
shape и catalog admission остават непроменени. Legacy fast path си остава в стария код;
новата функция не прави projection fingerprints от липсващи исторически schema тела.

- Policy е отделен **trusted server-owned** аргумент: explicit daemon/Desktop minimum и
  denylist, optional fixed used-surface profile с reference documents и qualified fingerprints.
  Няма default policy/нов production profile/нови qualified fingerprints. Unit profiles са
  изрично синтетични, не доказателства за исторически или текущ Desktop.
- Evidence е вече bounded, server-collected inert JSON. Това е consistency check, не
  атестация или freshness measurement. Данни за двата endpoint-а и socket epoch се snapshot-ват;
  contract source tags трябва да съвпадат точно, включително version build metadata.
- Profile трябва да описва **пълния използван daemon/Desktop договор**. Структурен reference
  не е автоматично qualified fingerprint. Реалният пълен profile (initialized/envelopes и
  останалите потребявани форми) и Desktop source evidence още предстоят; текущите test roots
  не стават production baseline чрез тази функция.
- Candidate projection/fingerprint се изчислява от documents, не се приема claimed hash.
  Известен qualified fingerprint от trusted policy дава `verified` след version/shape checks;
  нов fingerprint, съвместим с reference, дава `contract_checked`. Известният qualified hash
  е fast path преди conservative reference comparison (D4); policy може да пази няколко
  вече квалифицирани варианта. Shape/projection validation остава задължителна и тук.
  Няма автоматична promotion след schema equality или единичен probe. Qualification трябва
  да е за пълния profile/current client implementation; при промяна се сменя profile identity.
- D6 `contract_unverified` е само за изрично недостъпен matching binary/schema export при
  валидни версии и еднакви source tags. Известен breaking/unsupported used schema, липсващ
  profile, version/epoch binding change или malformed evidence **не** се превръща в probe-only fallback.
  Invalid/missing version остава blocked по D4, а не `contract_unverified`.
- Няма `ready`, granted rights или автоматично записване. Самото наличие на schema/probe
  флаг от модел не е доказателство; probe/approval полета не са валиден вход тук.

Технически се добавя отделен pure export в existing `fleet-notification-validation.ts`,
ползващ вече приетите semver и projection kernels. Това избягва нов слой/цикличен import
към legacy tuple helper. Няма filesystem, transport, activation или clock зависимости.

## Вход/изход

`policy = {daemon:{minimum,denylist}, desktop:{minimum,denylist}, profile?}`;
profile е `{surface,referenceDocuments,verifiedFingerprints}` (максимум 128 distinct lowercase
SHA256 fingerprints). Той се валидира чрез съществуващия projection kernel, не чрез guessed hash.

`evidence = {daemonVersion,desktopVersion,socketEpoch,contract}`. Contract има същите три
context tags и е или `{state:'available',...,documents}`, или `{state:'unavailable',...,reason}`.
D6 reasons са само `matching_binary_unavailable`, `schema_export_unavailable`,
`schema_export_timeout`; user cancellation, binary/socket change и projection error не са D6.
Няма target/grant/probe вход. Unknown fields и contradictory tags се отказват.

Неблокираният изход има копиран context, `requiresProbe:true`, `activation:'not_performed'`
и fingerprint само когато schema е проверена. `contract_unverified` има изрично warning.
Blocked изход няма `requiresProbe` (не разрешава разходване на probe turn). Никой изход няма
`ready`, implicit confirmation или approve права.

## Статус

Реализирани са pure export/type-ове в `fleet-notification-validation.ts` (само imports и
добавен код; старите функции не са редактирани) и 15 теста в `codex-queue-compatibility.test.ts`.
Първите 15/15 и strict TypeScript за двата файла минават. Тестът е в fast/release-CI lane;
нов source path в manifest не е нужен: съществуващият shared-lib tree вече го покрива.
Текущите regression проверки минават 152/152 целеви (9 файла), 868/868 fast (47 + 821),
strict TypeScript, manifest check 103 и diff whitespace. Няма fail/skip.

Независимият source review `hub-scout-050cebd9-a16b-49f3-98b2-4aeff15844b3` прочете preflight
и двата kernels без потвърден дефект, но изрично не е разгледал теста/договора. Затова
follow-up `hub-scout-572fb5de-0017-4d73-b15d-375da7db3612` прочете пълните test/doc/validation
файлове: няма потвърден дефект в очакванията, fail-closed или D4/D6 границите. Операторът
провери по шест native snapshot hashes за всяко ревю преди добавянето на тази бележка.
Прегледите са source-only; тестовете са изпълнени от оператора, не независимо от reviewer.
Няма proof за real Desktop compatibility или production profile completeness.

Дял 6 е готов за user review gate. Фаза 0 и останалата Фаза 1 не са приключени; няма
production profile, нови qualified hashes, probe integration или admission wiring.

Потребителят прие дял 6 чрез „Одобрявам — продължи“ и разреши дял 7: само catalog readiness
по D4 (required subset + protocol allowlist), с неизменени identity, queue pins и human
approval/authority gates. Няма live операции/активация или whole-plan opt-in.
