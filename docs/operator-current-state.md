# Operator current-state verification — explicit opt-in

## Защо е отделен contract

Директните operator edits/tests преди въвеждането на този contract нямат runtime effect-window records. Не ги възстановяваме от prose, transcript, JSONL история или списък с команди. Read-only reviewer може коректно да е `taskAccepted=false`/`changes=unchanged`; това не е дефект за прикриване. `manual`/`runtime-ui` assertions не се доказват автоматично.

Човекът изрично разреши минималния repair и отделно този current-state contract по **af-post-s4-continue-20261026-01**. Това не е нов implementation run, task reset или waiver. Състоянието се приема като **проверено сега**, не като доказана историческа атрибуция на промени.

## API

Съществуващият `dispatch_agent` получава optional:

```ts
review_mode?: "changes" | "operator-current-state" | "private-config-current-state"
```

Default/explicit `changes` пази стария fingerprint, recovery, review reuse и acceptance semantics. Няма автоматична миграция или избор на новия режим.

Current-state режимът изисква:

- `agent=code-reviewer|security-auditor`, **explicit `backend=native`**, без edit/write в tools и с Bash за actual checks (без Bash има early refusal); Bash остава subject на existing guards. Няма COMS или unsupported fallback.
- `scope_mode=existing`, без deliverables, **1–128 unique exact existing regular files**; без absolute paths, traversal, symlinks/aliases, globs или session outputs. Файловете са в Git repo-то на workspace-а или, когато workspace root-ът е обикновена папка с вложени repos (например `rin-docs/` и `ringithub/`), всеки файл в своето вложено repo, със workspace-relative път. Всеки файл трябва да е в trusted Git-visible dirty/untracked snapshot на своето repo. Файл извън наблюдавано repo е gap; gap прави revision-а unavailable и отказва целия candidate, така че частично покритие никога не се приема. Clean/ignored files не се добавят тихомълком; например Git-ignored PLAN се ползва като input reference, не като current-state candidate.
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

## Private configuration-only current state (separate opt-in)

`review_mode=private-config-current-state` supports private Codex notification
preparations without inventing a Git delta. Supply `private_config_files` (1–4
exact absolute JSON paths) and `verifier_sources` (1–32 exact repository-relative
source paths). Explicit native code/security reviewer, read-only tools with Bash,
all declared automated checks plus AF-MIN-CHANGE, fresh complete native capture,
validated completed submission and independent affirmative full-scoped review
are mandatory. No artifacts, Git scope or deliverables are accepted in this mode.

The only private namespace is the canonical, current-user-owned
`~/.local/state/agent-fleet/codex-events/<thread UUID>/<owner>/notification[-name].json`.
Namespace directories must be private 0700; their HOME/state ancestors must be
canonical, owned and not group/world-writable. Files must be nonempty, bounded
(64 KiB), regular, single-link, owned 0400/0600 valid opted-in notification
configurations with matching thread UUID and a valid offline preview. Aliases,
traversal, globs, symlinks and arbitrary roots are rejected. Declared helpers are
bounded (1 MiB each), canonical single-link owned source files (`js`, `mjs`,
`cjs`, `ts`, `mts`, `cts`, `sh`, `py`), not group/world-writable. Include every
verifier dependency, including Git-ignored session helpers; the independent
reviewer must assess semantic adequacy and dependency completeness. Fingerprints
prove declared state and execution, not that a verifier is adequate.

Private configuration bodies are never returned or attached by the capture/proof
modules: evidence contains metadata/digests only. Existing source-access, artifact
and shell guards still apply; this is not permission to read/export private bodies
or run activation commands. Verifiers must remain offline and not print private
payloads. The snapshot checks are not an OS sandbox or hostile same-user attestation.

A successful private review creates `agent-fleet.private-config-verification/v1`
evidence and a **distinct private process proof**. For a pure configuration-only
task, this satisfies its own acceptance/review obligations and permits the
assertion-prove process gate. Git `changedFiles` stays empty, ordinary Git stage
refs/review-reuse records stay untouched, and the read-only specialist still has
`taskAccepted=false`/`changes=unchanged`. The process verdict instead reports
`path=private-config-current-state`. Assertions still require explicit named
evidence; they are not marked proven by reviewer prose.

Closure is revalidated at actual process/prove use against current private/helper
fingerprints, repository revision, task/session/declarations, receipt generation,
epoch/capture and evidence bytes (including the reviewer return and proof),
classification and writer/overlap state. Missing live context fails closed.
Changed or failed/replayed captures cannot borrow the prior private proof.
Registered source paths, Git stage evidence/origin or active source review
additions exclude this route; private evidence cannot close unrelated source
obligations. Exact-action confirmations remain independent and are never waived.
Old `changes` and `operator-current-state` behavior is unchanged.

Implementation/fixture support does not mean this code is loaded in a running
session, that the feature is independently approved, or that a notification was
delivered. This feature authorizes no reload, enable, daemon/socket contact,
protected action, permission decision, grant/exemption/policy change, journal
replay or expiry renewal. Independent review of the entire feature remains
required; see the [approved specification](../SPEC-private-config-verification.md).

## Activation и приемане

Source tests не доказват, че работещият Pi е заредил поправката. Текущият стар runtime може да държи ledger-а open въпреки локално зелени tests/review.

1. Изчакайте финалния checkpoint report, всички child reviews и streaming/compaction да приключат. **Само човекът**, в Pi terminal/TUI на избрания `af/orchestrator`, подава `/reload`. Не изпълнявайте това докато този turn чака tool/question. При `Wait for ... to finish` изчакайте; не заобикаляйте отказа. Source SDK path/shutdown caveats са в [S5a runbook](codex-local-mcp.md).
2. В същия Pi разговор подайте: **„Продължи съществуващата af-post-s4-continue-20261026-01 от PLAN checkpoint. Не стартирай нов implementation run. Провери наличието на review_mode в dispatch_agent schema и възстановените assertions/task binding. Използвай един локален Pi code-reviewer, backend native, review_mode operator-current-state, за current-state verification със scope от реално променените Git-visible runtime/S5b файлове. Не включвай ignored PLAN в candidate scope; ползвай го като reference. Изпълни всички exact automated commands чрез reviewer-а и запази manual assertions open до реално named evidence. Не пишете source по време на review, не lowering-вайте gates и не давайте live Fleet grants.“**
3. Ако schema/roster/task identity не е налична/съвместима, спрете и докладвайте safe diagnostic. Няма implicit `new_task`, state reset, shell simulation на tool response или fallback process restart. Ако code-reviewer липсва от restored roster, може да се добави само необходимият persona по вече разрешения review scope.
4. Дръжте declared candidate файловете и текущия revision неизменни докато review/tests работят. След успех проверете отделния operator-state artifact/process verdict, `get_assertions`, и едва после записвайте manual/test results с named source и same revision. Ако API отказва, отказът остава blocker, не „приет по отчет“.
5. `/reload` променя Fleet sessionId/startedAt. Същият task ID/checkpoint остава, но remote client трябва да re-discover-не и човекът изрично да разреши reselection към новия epoch, ако ще управлява/чете remote. **Не** сменяйте binding автоматично. S5a smoke grant е отнет; runtime verification не изисква нов Fleet read/send grant.
6. Cleanup: няма server/listener, smoke grant, store deletion или config uninstall от този contract. Не закривайте чужди jobs. Eventual S5b native multi-target smoke е отделна човешка стъпка с explicit targets/grants и последващ forget.

Пълен scoped regression и independent security/code review са необходими преди да се препоръча activation. Не рестартирайте докато работата/прегледите са активни.
