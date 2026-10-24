# Сесиен избор на Git worktree

Fleet може да остане извън приложението:

```text
root/                    # може да не е Git repository
  af/                    # Fleet installation, configuration, resources, evidence
  repo/                  # main checkout на приложението
  repo.worktree/         # вече регистриран linked или detached checkout
  docs/                  # независимо, споделено documentation repository
```

## Стартиране

От `root/af`, след обичайния setup на Fleet и неговите зависимости:

```sh
just fleet --worktree ../repo.worktree --dry-run
just fleet --worktree ../repo.worktree
just fleet --worktree ../repo --herdr --project example
just fleet --worktree ../repo.worktree --herdr --project example
just flow quality --worktree ../repo.worktree
```

Пътищата на селектора са относителни към Fleet workspace (`af`); при launch без
наследен binding това е директорията на командата. По избор
`--repository ../repo` проверява изрично owning main checkout. Селекцията е startup
опция, не глобален active pointer. Fleet не създава, мести или премахва worktree-и;
операторът ги управлява с Git/Worktrunk. Без селектор се запазва legacy режимът.

`workspaceRoot` е `af`; `executionRoot` е избраният checkout. При copy installation
`resourceRoot` е също `af`; при управлявана symlink installation той е физическият
Fleet source root. Неговата identity е част от binding-а, а human config остава в
`af`. Произволен resource извън тези два проверени roots се отказва.
Agents, profiles, teams, overrides, guard policy, extensions, skills и prompts
остават workspace-owned. Git и относителните coding операции работят в target-а.
Конфигурацията на target-а не подменя Fleet конфигурацията. Workspace `AGENTS.md`
(или `CLAUDE.md`) е изрично подаден ресурс; автоматичното target-local discovery
е изключено. Проектните инструкции се четат като изрично поискани project data.

## Проверка, resume и откази

В интерактивна сесия `/af-worktree status` и `/af-worktree verify` показват binding,
namespace и конфигурационното състояние. Base project се запазва, но effective
project включва физическата target identity: еднаквите peer имена на два екипа не
ги свързват помежду им. Resume изисква същия workspace и същите физически roots.
Премахнат/подменен target, несъвпадаща history или липсваща задължителна workspace
policy водят до отказ, не до fallback към main. След такава промяна стартирайте
нова сесия с изричен селектор. Няма live switch на target в съществуваща сесия.

Fleet evidence, peer snapshots и workflow state са target-partitioned под `af`.
Интерактивната Pi history запазва стандартното global, cwd-scoped местоположение;
нейните custom entries носят immutable binding. Native specialists използват
workspace-owned session artifacts. Тези различни видове state не са permissions.

## System 1: отделно разрешение за всеки consumer

Съществуващото разрешение за main не разрешава source export от worktree.
`/af-worktree-consent agenticAsk` показва точния effective scope и изисква ново
интерактивно потвърждение. Повторете отделно за желаните consumers: `watchdog`,
`dispatch`, `proactiveReview`, `taskTriage`, `agenticAsk`, `fileDiscovery`,
`contextCompaction`, `damageGuard`. Рестартирайте след одобрение.

Approval не активира изключен consumer и не изменя конфигурация, budgets,
model/provider, local bindings или rule pins. Променен policy/config/scope изисква
ново одобрение. Непроецируем scope се отказва. Snapshot на scout е отделен physical
target и не наследява автоматично source-export approval от оригинала.
`needs_worktree_consent`, invalid/adaptation и off са различни от проверен helper
result. `providerChecked: false`/`applicabilityChecked: false` не са положителна
проверка на provider или local-rule applicability.

## Граници и optional integrations

- Shared docs се разрешават чрез изрични workspace-relative read grants. Това не
  разрешава writes; редакция на общото docs repository изисква отделен task scope.
- Browser/MCP, STT и remote clients запазват отделните си credentials/endpoints.
  Правилен cwd **не** означава отделни browser profiles, frontend ports, API,
  database или gateway. Не се пренаписват автоматично такива destinations.
- `/btw` и targeted Hermes conductor отказват тази комбинация; използвайте guarded
  `dispatch_agent`, Hub или targeted Pi peer. Външният Hermes conductor profile
  няма проверен split-root resource contract. Legacy conductor остава непроменен.
- `--all-extensions`, custom `--session-dir` и worktree селектори за installation
  lifecycle команди се отказват. Setup/doctor/deps/uninstall се изпълняват от `af`.
- Preview не извършва provider/browser/Herdr/gateway live проверка. Липсваща
  capability е gap, а не доказателство за работеща интеграция.

Това е проверено operational routing и bounded guards, **не OS sandbox** и не
изолация на външни услуги. Не копирайте Fleet в application worktree и не заменяйте
root contract с произволни symlinks или само `cd`.

## Regression runtime

`npm run test:full` използва проектния Pi SDK от `devDependencies` (в момента
1.1.0), а не версия, предположена от `PATH` или директорията на Node executable.
Отделният интерактивен launcher може да сочи към друга инсталация.
`CONTEXT_CONTINUITY_PI_RUNTIME` е изричен test-only override към SDK directory;
невалиден override се отказва, без silent fallback. Това не променя production
runtime selection или permissions. SDK fixtures изолират наследени Fleet role,
root и exemption metadata, за да проверяват собствената си synthetic session.
