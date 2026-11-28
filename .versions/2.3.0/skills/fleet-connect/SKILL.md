---
name: fleet-connect
description: Свързване/reconnect на текущия native Codex чат към точна Fleet сесия с едно native Pi потвърждение за права и известия.
---

# Свързване към Fleet

Ползвай само действително заредените native Fleet инструменти на текущия чат. Skill файл, SDK `clientInfo`, initialize UA и source каталог не установяват Desktop identity, loaded consumer, разрешение или readiness.

1. Нужни са `fleet_connect_prepare`, `fleet_connect_commit`, `fleet_connection_status`, `fleet_discover` и актуалният Fleet каталог, включително `fleet_response_read`. Липсата им е host/reload блокер; няма shell/retired CLI fallback, чужд thread ID или автоматично рестартиране.
2. Чрез `fleet_discover` избери точния поискан project/peer/sessionId/startedAt. При действителна двусмисленост попитай човека, не избирай по heartbeat. Metadata/discovery не дават права.
3. `read` е задължително; добавяй `send`/`approve` само при изрично искане. „Всички права“ означава `read+send+approve`; `approve` не е човешко одобрение на бъдещи разрешения. Новият bootstrap задава/заменя точно избраните права, не наследява стар send/approve grant. Правата и известията имат един общ срок, по подразбиране 12 часа.
4. Извикай `fleet_connect_prepare` с точния target и права, `notifications:true`. Това е read-only подготовка за authority: не записва права и не enqueue-ва probe. Показвай точния owner, права, общ срок, съвместимост и блокери. `desktopConfirmed`/`quiescentWritersConfirmed` от модела не заместват native потвърждение.
5. При липсващ/невалиден mapping обновеният Pi backend установява автоматично Desktop данните за поддържания Linux layout: един реален main процес, версия от неговия пакет, един работещ owned daemon socket, canonical Codex home и trusted CLI. Prepare не публикува mapping; единственият native Pi диалог одобрява и тези факти заедно с правата/известията. Не искай от човека PID/version/socket/home/CLI полета. Двусмислени/неподдържани данни или липсваща no-load capability спират с причина, без guessing/hydrate/resume. `/af-codex-events preflight` остава отделен expert manual path, не нормална предпоставка. При стар зареден runtime обясни нуждата от обновяване; не заобикаляй refusal.
6. При `prepared` извикай `fleet_connect_commit` **веднъж** с proposalId, без второ „Да?“ в Codex. Точният преглед/решение е в **един native Pi диалог**: автоматично установени Desktop/chat факти при нов mapping, owner/epoch, namespace, права, общ срок, quiescent writers и цена на probe. Само Codex процесът записва правата след това решение; AF не е втори allowlist writer.
7. Native commit връща `pending`, за да освободи текущия model/tool turn. Това не доказва съгласие, grants, активация или доставка. Кажи кратко да се потвърди в Pi и **приключи текущия turn**; не дръж tool call/активен polling loop в очакване на probe от същия чат. Резултатът се наблюдава чрез `fleet_connection_status`/Fleet View, не чрез повторно commit.
8. При действително нов адресиран `FLEET_BOOTSTRAP_PROBE_V1` в този чат отговори като terminal/final assistant само `FLEET_PROBE_ACK <probeId>`. Без обяснение, инструменти, grants, permission решение или промяна на задача. Probe не е човешко одобрение. Активацията изисква exact fresh ACK плюс `notLoaded` преди/след; queue ACK сам не е model delivery.
9. Decline/cancel/stale/unknown не задействат автоматичен retry, друг ID или нов enqueue. Cached duplicate commit е стар receipt, не текущо readiness доказателство. Частично записани права не означават включени известия. Disable спира известията, но не отменя правата им вместо Codex.

## Съвместимост и restart

- `verified`: доверен вече квалифициран fingerprint; `contract_checked`: проверен used contract, но не квалифициран host; `contract_unverified`: schema не е проверена, с изрично предупреждение и задължителен probe. `blocked` не се заобикаля. Няма нови квалифицирани fingerprints само от версия, документация или тестови fixtures.
- Минимална eligibility: daemon `0.166.0`, Desktop `0.166.0-alpha.5.1`; това не е qualification/consent. Истинската Desktop версия не се взема от SDK версията.
- След засечена daemon промяна runtime първо спира. Само при същия compatibility level/непразен fingerprint, запазени owner/права/срок/identity и първоначалното Pi съгласие може да има автоматична read-only проверка и един нов probe. До 4 такива проби в оригиналния lease, без периодични проби, подновяване на права или replay. Unknown/друга schema/липсващ fingerprint оставят runtime спрян.
- Нов AF epoch изисква нов явен reconnect и едно ново Pi решение; старите send/approve права не се прехвърлят автоматично. Запазват се същите journals и исторически unknowns, не се започва начисто за retry.
- `notifications:false` остава отделният legacy rights-only workflow със собствените му preview/consent правила. Той не активира известия, не издава bootstrap admission и не е обход на Pi notification confirmation.
- След действително включване изпълни еднократен read-only обзор за стари съобщения/въпроси; не обещавай автоматично ретроактивно доставяне.

Файлът трябва да е инсталиран по поддържания механизъм на хоста. Repository presence, synthetic tests и queue ACK не доказват реална Desktop/voice доставка или готовност на текущия хост.
