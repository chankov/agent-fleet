# Изричен атомарен reconnect lease — Codex store primitive

`AllowedSessionsStore.reconnect(proposal, current, expectedRevision, signal)` е отделен
reviewed transition за бъдещия единствен Codex rights writer. **Още не е вързан** към
model tools, AF control/UI, producer/presence или bootstrap activation. Самият API не
доказва човешко съгласие, host identity или quiescent writers. Trusted caller ги проверява
преди извикване; AF не получава собствен writer върху Codex allowlist-а.

Proposal фиксира namespace (store instance), alias, точен previousTarget, точен нов AF
project/peer/sessionId/startedAt, канонични read/send/approve rights и общ expiresAt.
Read е задължителен; правата са **замяна**, не наследяване/сливане на старите grants.
Revision и старият target са CAS pins; новият трябва да съвпада точно с един current
snapshot, без duplicate binding. Alias сам не избира нов epoch. Няма discovery/retargeting.

При success има една locked atomic v3 публикация и едно увеличение на revision. Разрешени
са същият epoch, expired lease или изрично заменен стар epoch; няма автоматично възстановяване.
Input/current snapshots се отделят преди първия await; current е bounded до 128 entries.
Missing state/alias не създават нов namespace/binding. Старите `connect` (create-only) и
`rebind` (read-only) запазват договорите си; legacy v1/v2 се надграждат само при този изричен
lease transition. V3 не се downgrade-ва. Никакъв public tool не получава reconnect fallback.

Abort преди rename запазва стария lease и чисти owned temp/lock. Abort след rename/sync
се връща като `COMMIT_UNCERTAIN`, не fake rollback/success; caller не повтаря write автоматично.
Проверка има и след lock cleanup преди връщане. Вече извършена filesystem операция не може
да се undo/interrupt-не. Съществуващото fail-closed persist-ване на положително наблюдавана
staleness остава; отказът може да запише отнемане на стари права, никога нов grant.

10 нови synthetic tests (65 store общо) покриват expired/new epoch, exact replacement,
CAS/alias/unique/current checks, detached inputs, concurrent writers, четири cancellation
checkpoints, invalid/pre-cancelled/missing state. Използват само owned temporary policy
fixtures; не са operational grant или Phase5 доказателство. Store е cooperative same-UID
policy, не human authentication/sandbox; existing lock/durability assumptions остават.

HEAD counterfactual в owned temp copy с original store: точно 10 reconnect cases са red
с липсващ API (0/10), без git writes; current suite е green 65/65. Final source-only review
`hub-scout-bc195930-c83b-42cb-80fe-f278278acdd5` не потвърди дефект; parent провери шест
snapshot/current hashes за store/reader sources/tests/docs. Reviewer не е пускал tests;
търсил е DoD по грешен nested path, parent е прочел canonical references/definition-of-done.md.
Final regression:433/433 targeted17,979/979 fast47+932/113files,scoped strict TS,manifest103,
whitespace зелени. Store suite е изрично targeted, не fast; няма operational rights write.
