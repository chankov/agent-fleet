# Codex известия: native bootstrap и reconnect

Това е **нерелийзнатият minor workflow**, не доказателство за текущия Desktop. Изпълнените тестове използват собствени временни процеси, socket-и, proc/rollout fixtures и schema export. Реални Desktop/historical/Phase5 проверки остават отделни; няма нов квалифициран fingerprint или автоматична активация от release.

## Нормален поток след изпълнени identity prerequisites

1. В точния Codex чат поискай връзка към еднозначен Fleet project/peer. `fleet_discover` избира точния `sessionId/startedAt`; source metadata не е разрешение.
2. `fleet_connect_prepare` подготвя точен namespace/owner/rights/common deadline, измерва daemon/contract и проверява реална no-load reader capability. Не записва права и не enqueue-ва probe. При липсващи факти спира.
3. `fleet_connect_commit` се извиква веднъж. В native flow връща **`pending`**, за да приключи текущият model/tool turn преди същият чат да трябва да отговори на probe. Handoff receipt не доказва съгласие, права, готовност или доставка. Няма активен polling loop или повторен commit за „довършване“.
4. **Един native Pi диалог** показва точния чат, AF owner/epoch, права, общ срок, revision, съвместимост, quiescent-writer prerequisite и цена на probe. Model booleans и второ „Да?“ в Codex не са заместител.
5. Само **Codex MCP процесът** записва точно избраните права с namespace/revision/old/new-epoch CAS. AF координира и чете policy; не е втори allowlist writer. Reconnect заменя правата, не наследява стар send/approve. Общият срок по подразбиране е 12 часа, максимум 720 часа, фиксиран от prepare.
6. След проверен запис се изпраща **един** nonce probe. Той може да събуди модела и изразходва контекст/токени. Новият terminal assistant отговор трябва да е само `FLEET_PROBE_ACK <probeId>` — без commentary, инструменти или permission решение.
7. Само след точен нов ACK, идентичен metadata path и `notLoaded` преди/след се публикуват частна конфигурация и process-local admission и се включва runtime. Файл/JSON не възстановява admission след рестарт.

`read` е задължително. `send` и `approve` се добавят само при изрично искане/показан Pi scope. Approve е право за отделно обосновано machine решение, **не** автоматично човешко одобрение. Message, question и permission са видове известия, не grant-и и не готови отговори.

## Какво е необходимо преди това

Native presence се публикува след действително валиден контекст и инструментален call. Съдържа namespace, MCP instance, наблюдаван SDK clientInfo/protocol/catalog и timestamp — **не** human consent, Desktop версия, grants или consumer readiness. Публикуването/attach request са ограничени частни metadata записи, не изцяло бездисков read.

При липсващ или невалиден mapping текущият Pi backend установява фактите автоматично за Linux инсталацията `/usr/lib/chatgpt/ChatGPT`: bounded same-UID main-process discovery, версия от safe bounded `resources/app.asar` package metadata, проверения managed socket alias за същия Codex home (или точно един owned listening socket в `/tmp/codex-daemon-<uid>`, когато managed alias липсва), canonical configured Codex home и trusted CLI от `packages/standalone/current`. SDK/UA/model flags не са fallback. Двусмислени/неподдържани данни спират с `desktop_discovery_*`, без repair/start/guessing.

Prepare пази само process-local draft/proof, проверява used contract и реалната no-load capability; не публикува mapping и не дава права. **Един общ native Pi диалог** показва тези Desktop/chat/catalog факти и exact owner/rights/common deadline/probe scope. Само след истинското потвърждение се публикува mapping, после Codex записва правата и се изпълнява един probe. Decline/cancel преди публикация не записва mapping/права; неизвестна публикация не се повтаря автоматично. Process/start/executable/package evidence се revalidate-ва около решението и преди bytes. Втори жив native writer остава отказан; стари metadata от изключен MCP не надделяват над точния singleton live attachment.

`/af-codex-events preflight` остава отделен expert manual mapping path. Не е необходим за нормалния supported automatic connect и не трябва да се представя като задължително ръчно попълване. Други инсталационни layouts/платформи още нямат automatic discovery, а не получават фиктивно успешно свързване.

- SDK `clientInfo.version` и daemon initialize `Codex Desktop/...` UA не атестират реалния Desktop executable/consumer.
- Daemon build версията се извлича само от първия `originator/version` token на действителния initialize отговор. Приемат се точно измереният `Codex Desktop` и собствените initialize originators `agent_fleet_contract_observer` / `agent_fleet_queue_bridge`, със строг SemVer и граници/control/length проверки. SDK/terminal/suffix версии не са fallback; друг originator или невалиден първи token отказва. Тази корекция не е нова Desktop identity/qualification или разрешение за queue.
- Mapping pin-ва PID/start ticks/executable identity/bytes и native контекста; live preflight проверява избран процес, не сканира всички процеси. Смяна на процеса/native MCP instance или mapping файла изисква нови текущи факти и едно ново Pi mapping/bootstrap одобрение; supported automatic flow ги събира сам. Това ограничение не се скрива като „едно натискане след всеки възможен рестарт“.
- Изисква се актуалният required28 Fleet каталог и реална no-load capability за този path/thread. Source schema/reader код, model self-report и липсващ/null path не ги доказват.
- Старите policy writers трябва да са спрени. Channel singleton и private filesystem checks са cooperative same-UID защити, не cryptographic human/host authentication или sandbox срещу злонамерен същия UID.
- Няма daemon start/install/auth, автоматичен host reload, resume/hydrate, чужд thread или shell fallback.

## Съвместимост

| Статус | Значение |
| --- | --- |
| `verified` | Fingerprint е предварително квалифициран от доверена server policy; пак се изисква текущ probe. |
| `contract_checked` | Използваният contract съвпада/е съвместим, но host qualification не е установена. |
| `contract_unverified` | Няма доверен matching binary/export или export е timeout; показва се warning и probe остава задължителен. |
| `blocked` | Версия/identity/evidence/schema не минават проверките; няма fallback към активация. |

Eligibility floors са daemon `0.166.0` и Desktop `0.166.0-alpha.5.1`; denylists и `verifiedFingerprints` първоначално са празни. Floors не са qualification/consent. Историческият manual tuple admission остава отделен и не получава нов `0.167.x` tuple.

Bundled bootstrap reference е `fleet-codex-notification-bootstrap/v1`, **`qualification: not_qualified`**, с fingerprint `cf611f03213d2306972768f8b00c6628ecba67cadc7e3de947eb3bb6764a06ff`. Това е offline CLI schema reference, не измерване на текущия Desktop. Matching CLI се изпълнява само изрично избран/доверен, с фиксираните `--version` и offline schema-export команди; executable bytes/alias се revalidate-ват и при cache reuse.

## Drift, lease и неизвестни ефекти

При засечена daemon version/socket-epoch промяна старият runtime първо спира преди addressed payload. Отделен safety watcher, **не renderer/status refresh**, може да започне ограничена проверка под първоначалното Pi съгласие:

- същите live native identity/AF owner, policy revision/права и оригинален common wall/monotonic срок;
- същият compatibility level и **непразен идентичен used-contract fingerprint**;
- read-only recheck, един нов nonce probe, после още една проверка;
- до **4** автоматични проби за първоначално потвърдения lease; няма периодични проби, нов Codex grant или подновяване на срока;
- нов notification binding epoch, **същият journal root**, запазени стари terminal/unknown записи и source-ID dedup.

При `contract_unverified`, нов fingerprint/ниво, identity/rights/config drift, изтекъл срок или unknown probe runtime остава спрян и изисква нова изрична подготовка/потвърждение. Няма автоматичен replay на uncertain enqueue, публикация, grant или действие. Disable/reset/shutdown отменят pending работата; след възможна публикация не се обещава rollback.

При неуспешна D7 проверка cached native статусът и Fleet View запазват `d7_<етап>_<код>`: етап `inspect`, `probe`, `verify` или `activate`, точен allowlisted вътрешен код, `cancelled` или фиксиран `failed` за непозната грешка. Сурови exception/UA/path/stack данни не се публикуват. Причината остава след края на опита; status/render не започват нова проверка или probe. Кратък период без daemon може да остави този еднократен опит спрян; промяната не добавя автоматичен retry, нов срок или probe бюджет.

Нов AF epoch е нов адресат: явен reconnect с едно ново Pi решение, без автоматично прехвърляне на send/approve. AF restart не възстановява admission от запазен JSON. Native MCP disconnect спира потребителя; негов reload не обещава безпрекъсната доставка. Старите неизвестни събития са исторически, не current-scope reconcile/retry. Persisted non-default state root се запазва и след cold bootstrap; конфликт между известни roots спира, не започва „на чисто“.

## Fleet View и команди

Fleet View → **2** показва cached чатове. ↑/↓ избира по точен namespace, Enter отваря детайли, Esc връща. **e** включва/reconnect-ва, **d** спира известията, **p** стартира отделния factual preflight. Dashboard се затваря преди native Pi диалога; няма второ re-press потвърждение. Липсваща/stale/двусмислена presence дава guidance, не probe/enable.

`/af-codex-events connect|preflight|status|disable-chat` използва същия coordinator като native MCP. `status`, render, selection и cached refresh не потвърждават, не grant-ват и не пробват daemon. Детайлите разграничават SDK observation, последно проверени версии/очакван epoch, права/срок, notification state, probe receipt и queue evidence.

При грешка в mapping preflight Pi показва `Desktop preflight: <code>` само с allowlisted вътрешен код или OS errno (например `desktop_preflight_changed`, `desktop_preflight_not_confirmed`, `preflight_io_EACCES`). Непознатите грешки са `preflight_failed`; сурови exception съобщения, пътища и stack traces не се показват. `bootstrap_file_publication_unknown` означава, че mapping файлът може вече да е публикуван. Съобщението за грешка не доказва липса на запис: първо се проверяват точният mapping файл и cached статусът, без автоматично повторение. Този UI catch не записва отделен preflight journal и не обновява cached статуса с конкретния код.

След успешно включване изричните `grant_send` / `revoke_send` запазват notification read lease при непроменени namespace, store/binding, owner, read/approve и срок. Codex store записва частен bounded witness (`<policy-file>.send-lineage`, до 64 прехода и 32768 байта) преди policy публикацията; AF само чете и реконструира точната последователност. Текущата policy трябва да съвпада с доказаното крайно състояние. Това е cooperative same-UID evidence, не криптографска атестация на writer. Липсващо/повредено доказателство, пропуск, друга промяна или недоказуем ABA спират lease-а. Witness-ът сам не дава права и не възстановява спрян runtime. Грешка в optional continuity записа не блокира изричните send grant/revoke; недоказаната continuity остава отказана. Generic reconnect/no-op, който би могъл да наследи непубликуван бъдещ send witness, първо го оттегля преди policy публикацията; реалното отнемане на read/approve не зависи от такова доказателство.

Send преходът не променя notification config, първоначалните authority revision/binding epoch/probe receipt, общия срок или no-replay outbox; няма нов probe, confirmation или activation. При отделно засечена daemon промяна D7 използва свежите действителни права само след доказана send последователност, със същия оставащ бюджет. Desktop/process/mapping промяна продължава да отказва; send промяна не поправя вече невалидна Desktop идентичност.

Legacy `prepare|enable <private config.json>|disable` и `notifications:false` rights-only API запазват отделните си договори; не създават bootstrap admission. Не стартирай legacy и bootstrap runtime за същия чат едновременно. Disable не отменя Codex правата вместо човека. При липсващ control cache познатият runtime пак може да бъде спрян изрично.

`fleet_connection_status` е bounded observation, не live delivery proof. Cached previous commit е исторически receipt. Queue ACK не доказва прочитане, отговор, разрешение или завършена задача. След реално enablement направи еднократен read-only обзор за стари съобщения/въпроси; не обещавай ретроактивна доставка.

## Отделно разрешен жив preflight (не е изпълнен тук)

Препоръчителен handoff: **нова Fleet/Pi сесия с обновения код, същият Codex чат**. Зареждането на repo/package/skill не доказва, че текущият Desktop/MCP ги е приел. Няма автоматично рестартиране на работеща доставка за тест.

Преди всяка жива стъпка човекът избира точните host profile/principal, native chat, AF project/peer/sessionId/startedAt, private roots, PID и вече работещ socket; fixture IDs не са допустим заместител.

1. **Само предварителни факти, без grants/queue/activation:** отделно разрешение за точните read-only process/executable/catalog/daemon-version/epoch/metadata-path/header проверки и, ако са избрани, доверените offline CLI export команди. Обяви изрично кратките private presence записи; factual mapping publication също е отделна, показана native Pi операция. Без transcript body dump, broad process/profile discovery, auth reads или инсталационни промени. При липсваща identity/capability спри.
2. **Едва след отделно изрично разрешение за effects:** native prepare → един commit handoff → един истински Pi confirmation → един Codex rights CAS → един queue probe/нов terminal ACK → private config/runtime activation. Предварително фиксирай права/общ срок/cleanup. Няма автоматичен retry при unknown; сравни преди/след policy revision и докажи, че AF не е writer.
3. **Отделно адресирани delivery тестове:** message → question → permission, с истински receipts и резултат от действието. Никакъв автоматичен answer/approve, изкуствено „Да“ или представяне на source/synthetic evidence като жив резултат. Провери expiry/disable и reconnect без пренасяне на стари права/unknowns.

Не изпълнявай installer/update/reload/daemon commands, реални probe/grant/config операции, Git writes или публикация като страничен ефект от документация/тестове. Наличните source tests и независими reviews са отделна evidence категория от реална Desktop/voice/historical qualification.


### New chats and date directories with umask 0002

Read-only prepare checks the exact metadata-selected rollout path and header without
changing filesystem permissions. Group-writable, same-UID session directories
(0775) and rollout files (0664) are repairable prerequisites, not ACK evidence.
The one native Pi enable/reconnect confirmation also authorizes removing only the
group-write bit from that chat's file and its owned ancestors under
`CODEX_HOME/sessions`. This runs after consent and before rights/probe/activation,
including for an existing Desktop mapping. It uses pinned no-follow handles,
rechecks scope and identity, never recurses, never adds permissions, and never
changes file content, other chats, umask or Desktop configuration. A new day or
new chat follows the same path automatically. Decline leaves all modes unchanged.

World-writable paths, foreign ownership, symlinks, hardlinked rollout files,
wrong thread headers and identity drift still fail closed. Codex home remains a
strict prerequisite. The actual ACK checkpoint and its subsequent reads still
reject both group and world writes; preparation alone cannot acknowledge a probe.
A partial securing failure can leave already tightened modes in place, but does
not widen them back, grant rights or trigger a probe. Reload the Pi extension to
load this correction; it does not require a Desktop or daemon restart.
