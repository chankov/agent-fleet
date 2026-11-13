# Offline used-surface inventory — дял 8, незавършен

Дял 7 е приет. Разрешението за дял 8 е само offline used-surface profile и reference/
мутационни fixtures: без нови qualified fingerprints, runtime admission или live операции.
Настоящият inventory не е работещ пълен profile, qualification или завършена Фаза 1.

## Проверени consumers и данни

- `scripts/lib/codex-unix-queue-rpc.ts`: initialize request със string UUID id, clientInfo
  name/title/version, experimentalApi=true; response id/error/result/userAgent; следва
  `initialized` с `params:{}`; method response id/error/own result. Не изпраща approval replies.
- `scripts/lib/codex-daemon-observer.ts`: отделен initialize-only request (experimentalApi=false),
  проверява object frame, own method/error, id, result object и userAgent. Не изпраща initialized.
  Ignore-ва notification/server-request frames; epoch/UA граматиката са отделни local guards.
- `scripts/lib/codex-desktop-queue-host.ts`:
  - `thread/read`: threadId/includeTurns=false; чете thread.id и thread.status.type=notLoaded.
  - `thread/queue/add`: threadId/clientUserMessageId/input с един text/text_elements=[];
    чете queuedSubmission.id/clientUserMessageId/input.length/input[0].type/text.
  - `thread/queue/list`: threadId/limit=100/cursor; чете data[], clientUserMessageId, nextCursor,
    matching input.length/input[0].text и id. Queue observation не е model-delivery ACK.
- `thread/loaded/list` е в RPC whitelist, но няма production caller в проверените scripts/lib
  и harnesses/lib; не се добавят fictitious consumed fields само заради allowlist.
- readState/canAcceptDirectInput не се четат от тези consumers. ServerNotification payloads
  също не се четат; frame/payload/message-count budgets и filtering остават local guards.
  Това трябва да се преоцени при бъдеща probe/bootstrap wiring, не да се декларира вече готово.

Оригиналните exports за 0.167.0 и 0.167.1 съществуват в
`/tmp/fleet-codex-contract-wLLGaX/`. Четени са само вече налични JSON файлове — без binary,
socket, queue или live probe. JSONRPC envelope/ClientNotification sources още не са добавени
към fixed six-root exporter; бъдещото му wiring/разширяване не е разрешено от този дял.
Наличните Linux CLI exports не доказват actual Desktop executable/consumer identity.

## Възпроизведени kernel предпоставки

Пълният profile не може честно да пропусне използваните envelope полета. Pure `projectSchema`
върху непроменения 0.167.1 export възпроизведе:

| Реален wire случай | Възпроизведен отказ преди дял 8a |
|---|---|
| JSONRPCResponse.id → RequestId anyOf(string, integer/int64) | unsupported_anyof:envelope.id |
| JSONRPCResponse.result е JSON Schema `true`; presence/payload са нужни отделно | object_required:envelope.result |
| initialized изпраща params={}, недекларирано property, разрешено от open schema | used_field_missing:envelope.params |

Не е допустимо да заобиколим това чрез непълен „пълен profile“, подмяна на raw schemas,
response-as-request selection или мълчаливо разрешаване на general anyOf. Особено важно:
ако игнорираме изпращаното initialized.params, бъдеща optional typed params декларация може
да промени приемането на нашия пакет, без projection да забележи.

## Material scope gate и разрешен prerequisite

Profile дял 8 е отложен преди implementation. Промяна в kernel договора е извън първоначалния
profile-only обхват; потребителят отговори **„Да — отделен малък kernel дял“** на отделния
scope въпрос. Разрешен е само дял 8a: bounded disjoint primitive response-anyOf support,
с непроменени съществуващи projections/hashes, fail-closed general/object compositions,
собствени тестове/review/user gate. Това не приема profile дял 8 и не разрешава останалите
opaque/presence или open sent request-field предпоставки. Няма runtime admission,
minimum defaults, нови qualified fingerprints, qualification или live операции.
[Дял 8a implementation/evidence](response-unions.md) е приет. Отделно е разрешен
[дял 8b](opaque-response.md), само required opaque response property със schema true.
303/912 проверки са зелени; source-only review няма потвърден дефект, дял 8b е приет.
След status/checkpoint/manual compaction gate потребителят написа „продължи“ за отделния
[8c](open-sent.md). Минималният open sent empty-object template сега проектира original
initialized.params и в двата offline exports; 309/918 са зелени, source-only review няма
потвърден дефект (без независимо изпълнени тестове). Дял 8c е приет; потребителят изрично
отмени междинните phase gates и поиска вътрешни reviews/корекции. Profile е в работа,
без нови live permissions или fabricated qualification.
Full profile, qualification, runtime admission и live операции не са разрешени от този дял.

След whole-plan указанието [current profile](profile.md) покри12roots/8files от двете реални
offline CLI exports, no qualification. Known text_elements:[] не избира непращани items.
Legacy RPC null/binary/method/error guards са поправени и tested с owned fake endpoints;
reconcile type:text guard съгласува selected variant. Schema projection пак не е runtime
value validator. [Bootstrap core](bootstrap.md) е mocked coordinator, още не production driver.
