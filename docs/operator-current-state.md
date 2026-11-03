# Operator current-state verification — explicit opt-in

## Защо е отделен contract

Директните operator edits/tests преди въвеждането на този contract нямат runtime effect-window records. Не ги възстановяваме от prose, transcript, JSONL история или списък с команди. Read-only reviewer може коректно да е `taskAccepted=false`/`changes=unchanged`; това не е дефект за прикриване. `manual`/`runtime-ui` assertions не се доказват автоматично.

Човекът изрично разреши минималния repair и отделно този current-state contract по **af-post-s4-continue-20261026-01**. Това не е нов implementation run, task reset или waiver. Състоянието се приема като **проверено сега**, не като доказана историческа атрибуция на промени.

## API

Съществуващият `dispatch_agent` получава optional:

```ts
review_mode?: "changes" | "operator-current-state"
```

Default/explicit `changes` пази стария fingerprint, recovery, review reuse и acceptance semantics. Няма автоматична миграция или избор на новия режим.

Current-state режимът изисква:

- `agent=code-reviewer|security-auditor`, **explicit `backend=native`**, без edit/write в tools и с Bash за actual checks (без Bash има early refusal); Bash остава subject на existing guards. Няма COMS или unsupported fallback.
- `scope_mode=existing`, без deliverables, **1–128 unique exact existing regular files** в един Git repo; без absolute paths, traversal, symlinks/aliases, globs, nested worktrees или session outputs. Всеки файл трябва да е в trusted Git-visible dirty/untracked snapshot. Clean/ignored files не се добавят тихомълком; например Git-ignored PLAN се ползва като input reference, не като current-state candidate.
- Всички вече регистрирани task paths трябва да са обхванати. Не се губи стар scope чрез по-тясно ново приемане.
- Runtime-owned before/after revisions и task identity трябва да съвпадат; source mutation, stale task/requirements/input, writable overlap или unavailable snapshot отказват приемане. Snapshot/guard checks не са filesystem transaction или hostile same-user attestation.
- Изпълняват се **всички active automated assertions**, не само IDs, споменати в task prose, плюс AF-MIN-CHANGE. Изисква се поне един explicit automated criterion освен AF-MIN-CHANGE; manual-only/AF-MIN-only ledger не се приема. Всеки трябва да има актуален runtime-produced passed check/evidence, matching task/revision/requirement binding; cached passed status, prose или listed command не са proof. Подайте всяка exact test command като отделен approved Bash call. Не заобикаляйте denied commands или action-confirmation gates.
- При enabled native `submit_result` се изисква действителният validated receipt със `status=completed`, не status от prose/parser. `partial`, `blocked` и липсващ receipt не приемат candidate дори при APPROVE text и passed tests. Legacy transport без този tool пази старите условия; това не е fallback при липсващ enabled receipt.
- Независимият review трябва да е complete, положителен, със същите inputs/revision/scope и без blocking findings, въпроси или research requests. Existing wide/full-scoped-regression policy остава. REVIEW semantic adequacy не се атестира криптографски от parser-а; reviewer-ът трябва реално да прочете relevant source, да reuse-не unchanged completed coverage и да посочи ограниченията.

Native `**Verdict:** APPROVE`/`**Verdict**: APPROVE` вече са разпознаваеми, както plain APPROVE/Verdict: APPROVE. Всеки recognized REJECT veto-ва APPROVE; incidental prose/JSON не е verdict. Това не затваря gate без останалите условия.

## Какво означава резултатът

Успехът създава runtime evidence artifact `agent-fleet.operator-state-verification/v1`, съдържащ current revision, exact scope, actual check references и `historicalAttribution=not_claimed`. Използва се реалният six-argument artifact writer със captured sessionDir и kind=evidence; payload-ът се readback-ва byte-exact от regular non-symlink file под същия private namespace преди записване на acceptance. Missing/hollow/wrong-kind/foreign-session artifact не е proof. Process origin/path е `operator-current-state`. Нито кодът е „пренаписан“, нито child `changes` е фалшифициран: read-only child остава `unchanged` и `taskAccepted=false`, а отделният `operatorStateVerification.status=accepted`/process verdict описва новия contract.

Manual/runtime-ui ledger entries остават open до отделно изрично `update_assertion` с действителното named evidence, след като process gates позволяват това. Не ги маркирайте proven само от reviewer summary. При failure няма нов candidate registration/acceptance/review proof за тази проверка; не се редактира persisted state, не се lowering-ват risk/tier и не се правят празни edits за симулация на промени. Ако child е нарушил read-only contract и е писал, actual delta остава видим; няма automatic rollback или silent acceptance.

Origin се пази при state normalization/restoration; при следващ действително атрибутиран writable acceptance old current-state label се премахва. Revision changes отварят отново review/acceptance. Няма automatic grant, Fleet rebind, command send/answer, desktop/Pi restart или publishing.

## Activation и приемане

Source tests не доказват, че работещият Pi е заредил поправката. Текущият стар runtime може да държи ledger-а open въпреки локално зелени tests/review.

1. Изчакайте финалния checkpoint report, всички child reviews и streaming/compaction да приключат. **Само човекът**, в Pi terminal/TUI на избрания `af/orchestrator`, подава `/reload`. Не изпълнявайте това докато този turn чака tool/question. При `Wait for ... to finish` изчакайте; не заобикаляйте отказа. Source SDK path/shutdown caveats са в [S5a runbook](codex-local-mcp.md).
2. В същия Pi разговор подайте: **„Продължи съществуващата af-post-s4-continue-20261026-01 от PLAN checkpoint. Не стартирай нов implementation run. Провери наличието на review_mode в dispatch_agent schema и възстановените assertions/task binding. Използвай един локален Pi code-reviewer, backend native, review_mode operator-current-state, за current-state verification със scope от реално променените Git-visible runtime/S5b файлове. Не включвай ignored PLAN в candidate scope; ползвай го като reference. Изпълни всички exact automated commands чрез reviewer-а и запази manual assertions open до реално named evidence. Не пишете source по време на review, не lowering-вайте gates и не давайте live Fleet grants.“**
3. Ако schema/roster/task identity не е налична/съвместима, спрете и докладвайте safe diagnostic. Няма implicit `new_task`, state reset, shell simulation на tool response или fallback process restart. Ако code-reviewer липсва от restored roster, може да се добави само необходимият persona по вече разрешения review scope.
4. Дръжте declared candidate файловете и текущия revision неизменни докато review/tests работят. След успех проверете отделния operator-state artifact/process verdict, `get_assertions`, и едва после записвайте manual/test results с named source и same revision. Ако API отказва, отказът остава blocker, не „приет по отчет“.
5. `/reload` променя Fleet sessionId/startedAt. Същият task ID/checkpoint остава, но remote client трябва да re-discover-не и човекът изрично да разреши reselection към новия epoch, ако ще управлява/чете remote. **Не** сменяйте binding автоматично. S5a smoke grant е отнет; runtime verification не изисква нов Fleet read/send grant.
6. Cleanup: няма server/listener, smoke grant, store deletion или config uninstall от този contract. Не закривайте чужди jobs. Eventual S5b native multi-target smoke е отделна човешка стъпка с explicit targets/grants и последващ forget.

Пълен scoped regression и independent security/code review са необходими преди да се препоръча activation. Не рестартирайте докато работата/прегледите са активни.
