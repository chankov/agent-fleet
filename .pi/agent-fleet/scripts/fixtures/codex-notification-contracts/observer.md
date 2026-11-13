# Codex compatibility — connect-only observer (дял 5)

Потребителят прие дял 4 и изрично разреши този adapter **само с fake IPC тестове**.
Няма разрешение/изпълнение на live daemon/queue/probe/activation. Отделният дял отново
завършва с user review gate; това не е whole-plan opt-in.

## Обхват и избори

Нов `scripts/lib/codex-daemon-observer.ts` предоставя `CodexDaemonObserver`, който реализира
`DaemonObservationRpc` от measurement дяла. Няма `request`/queue API, filesystem writes,
CLI invocation, socket/credential discovery, daemon start или configuration/persistence.
Има само `socketEpoch(signal)` и `initialize(signal, expectedEpoch)`.

Избрано е **отделно, тясно read-only client тяло**, а не разширяване/refactor на стария
`CodexUnixQueueRpc`: така runtime delivery кодът, method whitelist-ът, approval/pins и
грешките му остават непроменени. Малкото private socket проверки са повторени умишлено;
observer-ът има по-строг нов epoch формат, който не мигрира стария delivery договор.
Мрежовият transport pattern (`ws` над `net.createConnection`) е същият съществуващ pattern,
без нови зависимости. Това не е MCP transport или нов публичен tool.

- Изрично подаден физически absolute UNIX socket path, максимум 100 UTF-8 bytes; никакви
  URI/control delimiters. Windows се отказва преди I/O. Timeout: 1–10000 ms, default 3000.
- Alias parent и target parent са private current-UID directories, physical и без directory
  symlinks. Разрешен е един current-UID file symlink към отделно проверен private socket.
  Няма symlink chain. Physical ancestor chains са current/root-owned, без group/world write
  освен sticky parent. Tests canonicalize собствения temp root за macOS `/var` alias.
- Socket е current-UID UNIX socket, без group/world write. Epoch е SHA256 върху explicit
  alias/physical path и inode/mode/uid/gid/link/ctime metadata, не remote initialize поле.
  Parent identity включва dev/inode/mode/uid/gid, но не ctime/nlink: чужда несвързана file
  активност в directory не трябва сама да се превръща в socket change.
- Captured physical target е точно path-ът на `createConnection`. Epoch се проверява
  преди connect, на open, при frames и преди резултат. Alias ретаргет и restored alias inode
  (ctime) не се приемат като старата връзка. Това са проверени filesystem observations,
  **не** OS peer credentials, executable/process attestation или защита от malicious same UID.
- Изпраща се точно един `initialize` packet, без `initialized` notification и без отговори
  на server requests, permissions, queue, transcript, resume, thread/read или wake операции.
  `experimentalApi:false` е умишлено: stable initialize не изисква queue APIs; measured
  InitializeCapabilities schema описва false като default. Няма HumanApproval/OAuth flags,
  които да променят server policy. Няма auth header, proxy, redirect или auth fallback.
- Връща се **само** `{result:{userAgent}, socketEpoch}`; чужди `socketEpoch`, `codexHome` и
  други полета се изхвърлят. UserAgent остава untrusted server string до `measureDaemon`
  grammar/version проверката и никога не установява Desktop consumer identity.

## Lifecycle / граници

Една invocation има свои raw socket, WS, request UUID, deadline и abort listener; няма shared
pending state. Собствените ресурси се затварят при success/error/cancel/timeout, включително
constructor/connecting failure. Обещанието се урежда след raw connection close. Deadline и
caller cancellation остават живи през това затваряне, с финален monotonic check преди data.
Late socket errors се обработват; transport events след собствен close не заменят success
с фалшив `CONNECTION_CLOSED`. Няма reconnect/retry/auth/CLI fallback.

Limits: 32 KiB/data message (`ws` maxPayload), 256 application messages; compression и
redirects са disabled. Transport-level ping/pong се управляват от `ws`, не са JSON-RPC
отговори и не са human/permission decisions.
Binary/non-object/invalid JSON/error/missing-UA frames отказват; strict UTF-8; matching-id
server request пак се игнорира, не се приема за initialize response. Всички грешки са
кодирани, без remote error details, credentials или raw protocol body. Няма твърдение,
че Node може да прекъсне блокирала kernel/filesystem операция; checkpoint след lookup
пази от late connect/send, когато due timer още не е получил event-loop turn.

Adapter-ът се използва **само в тестовете**, не е включен в runtime/bootstrap pipeline.
Той не приема нова версия, не създава approval и не доказва текущ consumer. Version policy,
projection/availability policy, consumer/probe/grant/lease и final freshness gates остават
задължителни в следващите дялове. Фаза 0, историческите schema тела и live Desktop evidence
остават отворени.

## Проверки / доставка

12 нови теста във `fleet-codex-daemon-observer.test.ts` използват собствени HTTP/WebSocket
servers върху private temporary UNIX sockets; няма реален Codex executable/socket/thread.
Покриват реалния `measureDaemon`→adapter път, forged epoch, server requests, unknown UA,
private file/alias/ancestor guards, alias ABA, malformed/binary/error/oversized/flood frames,
timeout/cancel/auth/remote close, concurrent invocation isolation и listener cleanup.
POSIX тестовете са skipped на Windows, където adapter-ът не се поддържа.

Първото изпълнение хвана syntax грешка в type import на теста; поправена е. След това
12/12 локални теста и strict TypeScript за двата нови файла минаха. Тестът е добавен в
fast/release-CI lane; source е добавен към existing workflow-runtime companion, а generated
manifest е актуален (103 items). Текущите regression проверки минават **137/137 целеви**
(8 файла) и **853/853 fast** (47 + 806), без fail/skip, плюс strict TypeScript и diff check.

Първият независим source review `hub-scout-2baed12d-7baa-4212-b38f-6ed8112831c6` не потвърди
дефект; шестте native snapshot hashes са проверени от оператора. Няма независимо изпълнени
тестове. След него операторът възпроизведе малка, но реална diagnostic грешка: deadline,
изтекъл вътре в HTTP request construction, се връщаше като CANCELLED. Regression първо
падна с `Error: CANCELLED`; сега се пази действителната TIMEOUT причина и няма connect.
Новият test mock-ва monotonic clock и собственото HTTP request construction, не live host.
Follow-up `hub-scout-083fce46-fe7d-4905-b83e-f9982802bf56` прочете текущия implementation,
всички тестове и договора: няма потвърден дефект в поправения constructor timeout path,
close settlement или останалите граници. Операторът провери шестте native snapshot hashes
срещу текущите файлове **преди тази бележка**. Това е source-only review, не независимо
изпълнение на тестове/OS races или peer identity attestation.

Дял 5 е готов за user review gate. Кодът, runtime registration и новият тест остават
unstaged на `main`; няма commit/pull/activation. Планът, production runtime wiring и
live/историческите Фаза 0 доказателства остават незавършени.

Потребителят прие дял 5 чрез „Одобрявам — продължи“ и разреши следващия дял: чиста
version/schema compatibility assessment логика, без runtime admission, нова approval форма
или live операции. Няма whole-plan opt-in; следва нов user gate.
