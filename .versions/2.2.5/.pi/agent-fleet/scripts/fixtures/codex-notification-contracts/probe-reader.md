# Локален четец за probe ACK — ограничен helper, без live qualification

`CodexProbeTranscript` отваря само `O_RDONLY` изрично подаден canonical rollout JSONL
под доверения Codex home `sessions/`. Няма discovery, hydrate/resume, daemon RPC, queue,
permission repair или връщане на transcript текст. Пътят не е model/tool аргумент.

Четецът проверява thread UUID в името и началния session_meta, ownership/modes,
non-symlink single-link regular file, parent identities и held inode. Checkpoint е private
instance-local handle с offset **преди** enqueue; старите/недовършени baseline записи не ACK-ват.
Ротация, наблюдавано truncation, подмяна на родители, невалиден UTF-8/JSON и лимитите отказват.

Приема се само нов `response_item` → message с `role: assistant`,
`phase: final_answer`, **един** `output_text`, чийто текст е точно `FLEET_PROBE_ACK <nonce>`.
Няма trim, concatenation, приемане на commentary/analysis/unknown/missing/null phase,
смесено съдържание, user/tool/event_msg или model self-report. Неизвестни формати отказват;
липсващ terminal phase не се представя като успешен wake/delivery proof.
Форматът е `codex-local-rollout-ack/v1`; това не доказва, че конкретен Desktop го използва.
Offline MessagePhase schema различава `commentary`/`final_answer` и допуска непоследователна
provider emission; schema наличност не е runtime transcript или reading-capability evidence.

Граници: 16 active/opening/closing handles, 30s maximum на checkpoint/wait, 2GiB source,
256KiB header, 2MiB appended scan, 64KiB line, 4096 records, 64 parent components.
Abort/close/stop освобождават handles; overdue evidence не се публикува. Не се обещава
прекъсване на stuck filesystem операции, hostile same-UID sandbox или детекция на всяка
междинна same-inode rewrite/truncate-and-regrow между наблюденията.

Caller отделно доказва exact metadata path/thread, Desktop/daemon identity и versions,
connection-bound socket epoch, current catalog/rights/owner, no-load read capability и
before/after `notLoaded`. Локалният ACK сам не квалифицира fingerprint, не променя права,
не разрешава нов tuple/admission, не създава config и не активира runtime.

12 synthetic owned-file tests покриват marker provenance/phases/content, baseline,
strict decoding/framing, unsafe paths, rotation/truncation, cancellation/stop, capacity и
opaque handles. Phase/content regression е видян red преди корекцията и green след нея.
Първият source-only review `hub-scout-d0fa5e8f-17ef-490a-b76b-b62c13108e52` посочи
conditional phase-boundary gap; parent избра fail-closed terminal-only policy, поправи
нереалистичния `final` fixture и затегна exact-content проверката. Reviewer не е пускал tests.
Вторият source-only review `hub-scout-3c631af3-3427-47e7-83c7-7f366c011ae0` потвърди
terminal/content проверката, но заяви два допълнителни дефекта с противоречиви предпоставки.
Parent ги провери по code и добави изпълнени regression tests: #check е преди #opening++ и
първия await, opening capacity вече е резервиран; stop по време на 16 pending acquisitions
отказва всички. #parents стига до root и lstat проверява всеки ancestor, включително symlink
на/над Codex home; и двата synthetic redirects се отказват. Тези две находки не се приемат
като потвърдени дефекти. Reviewer не е пускал tests. Следва final source review с тестовете;
още няма production/live доказателство.

Финалният source-only review `hub-scout-bc195930-c83b-42cb-80fe-f278278acdd5` не потвърди
дефект; parent провери шест snapshot/current hashes за reader/store sources/tests/docs.
Всички 12 reader tests са изпълнени от parent; reviewer не е пускал tests. Общият final
regression е 433/433 targeted17 и 979/979 fast47+932/113files; scoped strict TS, manifest103
и whitespace зелени. Това не завършва production driver/presence/UI или Phase5.
