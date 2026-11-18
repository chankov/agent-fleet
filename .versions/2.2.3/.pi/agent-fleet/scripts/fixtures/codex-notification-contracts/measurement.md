# Codex compatibility — measurement/export helpers (дял 4)

Дялът е изрично одобрен след projection дяла. Добавя вътрешни помощни функции, **не**
production RPC adapter/admission. Реални daemon/queue/probe операции не са изпълнявани;
проверките използват fake RPC и собствен временен fake executable.

## Нов вътрешен договор

`.pi/agent-fleet/scripts/lib/codex-measurement.ts`:

- `measureDaemon(rpc, {timeoutMs, signal})` извиква само trusted provider callbacks:
  `socketEpoch` → `initialize(signal, expectedEpoch)` → `socketEpoch`. Initialize връща
  отделни `{result, socketEpoch}`: epoch е **проверена metadata на самата връзка**, не
  server/MCP поле или ambient filesystem snapshot. Сравняват се и трите epoch стойности;
  така stable before/after стойности не прикриват друга връзка по време на initialize.
  Epoch е opaque, запазва Unicode path без normalization и отказва control/space символи.
- Version се извлича само от доказания във Фаза 0 UA prefix `Codex Desktop/<SemVer>`.
  Няма guessed aliases или fallback към `clientInfo.version`, локален CLI или чужд consumer.
  Резултатът е `initialize_version_observation`, не доказателство за Desktop identity.
- Provider-ът трябва да е connect-only, да пази private socket/owner checks и да затваря
  собствените си ресурси при abort. Съществуващият `CodexUnixQueueRpc.request` whitelist
  **не** е разхлабен. Реалният adapter трябва да бъде имплементиран/прегледан отделно,
  преди тези callbacks да се свържат към production.
- `exportSchema(binary, daemonMeasurement, options)` приема **изрично избран доверен
  executable**, абсолютен path. Няма PATH discovery, install/update/start/auth команди.
  Само `--version`, след това `app-server generate-json-schema --experimental --out`.
  CLI version трябва да съвпадне **точно**, включително build metadata; SemVer precedence
  equality сама по себе си не доказва еднаква exporter версия. Version/epoch и caller signal
  се snapshot-ват веднъж при входа: mutable аргумент не може да преименува стар export с
  нова версия/връзка, нито да остави listener върху стар signal.

## Execution/данни и guards

- POSIX-only exporter; Windows се отказва преди I/O. Binary е regular executable,
  собственост на текущия UID/root, без group/world write и set-id bits. Trusted symlink
  е разрешен, но canonical path, alias inode, file metadata и SHA256 се проверяват преди
  version, след version и след export. Промяна/retargeting отказва резултата. Физическите
  parent chains на canonical файла и alias directory също са current/root-owned и без чуждо
  write освен sticky parent; safe file mode не допуска изпълнение през replaceable ancestor.
- Binary fingerprint е само за избрания файл, **не** signature/interpreter/dependency
  attestation и не hash на running daemon executable. Довереният binary е precondition;
  това **не** е OS/network sandbox за произволен злонамерен код. Offline е фиксираният
  schema subcommand, не обещание за мрежова изолация на чужд executable.
- Export работи в собствен `0700` temp root. Temp parent е physical absolute directory,
  current/root-owned, без чуждо write освен sticky temp parent. CWD/HOME/CODEX_HOME/TMP са
  отделни собствени директории. Child env е explicit allowlist; няма наследени auth keys,
  provider настройки, NODE_OPTIONS или agent access grants.
- Няма shell. Child е в собствен POSIX process group; timeout/cancel/output-limit убива
  групата, изчаква close и чак след това се почиства. stdout/stderr са ограничени до 16 KiB
  всеки, stderr не се връща/логва. Version output се декодира strict UTF-8.
- Timeout е 1–30000 ms; defaults 3000 за RPC observation и 30000 за export. Monotonic clock
  се проверява и когато due timer още не е получил event-loop turn; overdue callback не
  печели race и не продължава към нови наблюдения. Първата timeout/cancel причина се пази.
  Scope остава жив през задължителния cleanup; след затварянето на directory handle има
  последен deadline/caller fence преди публикуване. File I/O проверява abort между regular
  file операции; няма обещание за прекъсване на блокирала kernel/filesystem операция.
- Binary read е chunked, максимум 512 MiB. Четат се само шестте self-contained roots,
  нужни за текущата test surface: ClientRequest, initialize response и четирите response
  schemas. Максимум 16 MiB/file и 32 MiB общо; bounded read не расте безкрайно при file growth.
  Symlink/nonregular/hardlinked file, linked parent, промяна при четене, invalid UTF-8/JSON
  или non-object document се отказват. Schema validation/projection остава отделна стъпка.
- Връщат се parsed `documents`, raw-byte `sourceHashes`, binary SHA/epoch и **измереният**
  daemon socket epoch. Временният root се почиства **преди** връщането на данни. Отворен
  directory handle pin-ва оригиналния inode до cleanup и не допуска маскиране чрез inode reuse.
  Ако root е заменен, helper-ът не изтрива чуждия inode и отказва; няма частични данни.
- Изключенията са кодирани `CodexMeasurementError`, без raw stderr/config/version output.
  Exotic callbacks/objects и OS failures не се превръщат в разрешение; бъдещият caller
  трябва да ги отчете като unavailable/blocked, не като enabling fallback.

## Граници за бъдещата интеграция

Всичко е observation, не `ready`/`compatible`/`verified`. Caller трябва да провери freshness
на socket/binary/owner state отново **след export и преди употреба**, да приложи minimum,
denylist и projection, и после потребителския confirmation/consumer/probe/grant/lease gates.
Съвпадаща версия не доказва еднакъв running binary или че Desktop е loaded consumer.
Unknown UA prefixes/schema export failure остават unavailable; няма fabricated measurement.

Няма промени по catalog, approval формата, notificationPreview, старите exact tuples или
реалния delivery path. Фаза 0 е отворена; реалният RPC adapter, schema availability policy,
compatibility assessment и UI integration остават за следващите дялове.

## Тестове и доставка

20 теста във `fleet-codex-measurement.test.ts` проверяват version/epoch/ABA fence, bad UA,
late callback/cancel/timeout, overdue synchronous callbacks, mutable input/signal snapshot,
post-cleanup deadline/cancel fence, exact CLI version/build mismatch, binary change/alias
retarget, private environment, root mode/replacement, output limits, bad/linked schemas,
process timeout/cancel, unsafe temp/binary/alias parents и unsafe/oversized binary. Всички създадени
процеси/файлове са собствени fixture ресурси; няма реален Codex executable или socket.

Новият тест е във fast/release-CI lane. Helper-ът е добавен към съществуващия
`companion:workflow-runtime` source list в `manifest-meta.json`; `install-manifest.json`
е регенериран (103 items, +1 source path). Това променя вътрешното инсталирано съдържание,
не добавя публична команда/автоматично изпълнение/нов consent или permissions.

Първоначално е открит проблем в negative fixture-а (`undefined` се е заменял с default UA)
и TypeScript narrowing; поправени са, без отслабване на тестовите очаквания. След поправките
20/20 локални теста и strict TypeScript минават. Последното regression изпълнение минава
125/125 целеви и 841/841 fast (47 + 794), без fail/skip; manifest check е актуален (103 items).
Съществуващият Фаза 0 export `0.167.1` съдържа 415018 bytes общо за шестте roots, под лимитите;
това е stat на вече събрани данни, не нов live export.

Първият независим source-only scout (`hub-scout-356e3187-ce76-475d-97c2-90068e80dda4`)
не потвърди дефект. Операторът провери всичките шест native snapshot hashes срещу тогавашния
код, тест, този документ, двата manifests и runner-а. Reviewer-ът не е изпълнявал тестове;
твърдението му за липсващ generated manifest не съвпада с native manifest-а, затова не се
брои като независим преглед на generated съдържанието. Parent manifest check/diff са минали.

След него операторът възпроизведе timeout пропуск: callback за 40 ms връщаше success при
5 ms budget, защото due timer още не беше изпълнен. Новият regression първо падна с
`Missing expected rejection`, след което monotonic check го поправи. Допълнителните тестове
доказват snapshot на metadata/signal през блокиран fixture export и timeout/cancel отказ
след cleanup. Последният fence не прекъсва cleanup и не премахва чужд заменен root.
Follow-up `hub-scout-ac41e24e-902b-4f6c-a2dc-2ddff784aef3` прочете поправения модул,
19-те теста, договора и root registration файловете; няма потвърден дефект в timer precedence,
snapshot/late callback/cleanup/publication fence. Прегледът е **само source**, без независимо
изпълнение на тестове. Операторът потвърди шестте native snapshot hashes срещу текущите
файлове преди добавянето на тази review бележка. Тестовете и strict TS са операторски проверки.
След този преглед операторът затвори още един конкретен trust gap: safe binary file mode
не спира друг UID да го замени през writable parent. Physical ancestor проверките се
изпълняват при всяка от трите binary snapshots, без промяна на allowed symlink file behavior.
Тестът отказва canonical и alias writable parent **преди** version command. И двете вериги
се canonicalize-ват, за да останат валидни macOS `/var` и други trusted directory aliases.
Финалният source follow-up `hub-scout-7df76085-a7f0-4548-919f-b79d612fab15` прочете guards,
трите call sites и теста: няма потвърден дефект. Операторът провери шестте snapshot hashes
преди тази бележка. Няма независимо изпълнен race с друг UID или platform-specific live тест;
тези ограничения не се броят за доказани. Финално: 20 нови, 125 целеви, 841 fast теста,
strict TypeScript, manifest 103 и whitespace/newline checks. Дял 4 чака user gate; целият
план, реалният RPC adapter и Фаза 0/live acceptance остават незавършени.

Потребителят прие дял 4 чрез „Одобрявам — продължи“ и изрично разреши следващия
connect-only RPC adapter, тестван само с fake IPC. Няма разрешение за live daemon/queue/probe
или активация; следващият дял отново завършва с user gate.
