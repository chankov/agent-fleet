# Човешка UI проверка — System 1 task triage

**Статус:** T6 случаите 1–5 са потвърдени лично в разговора и C3 е приет независимо; този checklist остава повторяем, не записва нови наблюдения автоматично. **Новият exact-action UI тест е лично изпълнен и одобрен според потребителското потвърждение; post-fix C4 review още е отворен и първият BLOCK остава запазен.** Потребителят даде общо одобрение на представения тест, не подробен отчет по случаи, screenshots или данни за терминала. Зелените тестове, PTY smoke или отварянето на прозореца не са човешко одобрение.

Всички случаи стартират истински production Hub от checkout-а, но в нов временен workspace с fake Jev transport и фиксиран synthetic Pi provider. Не се изпращат данни към API и не се наследяват истински ключове. Няма реален модел или автоматичен човешки отговор. Случаите 1–5 не изпълняват tools; само случай 6 предлага точно фиксираните synthetic bash/write/edit заявки по-долу. Не въвеждай реални задачи, @files, shell commands или други Hub execution команди в тези сесии.

## Стартиране

От root на agent-fleet:

```bash
node bin/test/helpers/task-triage-ui.mjs applied --keep
```

Замени `applied` с `waived`, `timeout`, `oversized`, `stale` или `action` за следващия случай. Всеки старт е нова сесия/workspace. `--keep` пази само синтетичните записи след `/quit`; launcher-ът показва директорията. Без `--keep` тя се премахва при изход. Това не прави setup или промени в текущия repo workspace.

**Общи действия:** `/af-agents-list` отваря Fleet. `1` отваря communication viewer. `e` включва session-only capture, `d` го изключва и изчиства. `Esc` връща към Fleet, `q` затваря Fleet. `/af-audit` показва metadata JSON. `/quit` излиза.

## 1. Applied и capture

1. Отвори `/af-agents-list`, натисни `1`: провери **capture OFF** и липса на възстановени payloads.
2. Натисни `e`, после `Esc`, `q`.
3. Изпълни `/triage-ui-fill applied`. Той само поставя текста в editor-а. Натисни **Enter** за изпращане.
4. Отвори `/af-agents-list`: провери `experimental`, `applied`, `current`, security probability, active addition и отворен review. Няма worker rows или зелено task acceptance.
5. Натисни `1`, избери запис и Enter. Провери request/response, probabilities и предупреждението, че provider result не е task acceptance.
6. Пробвай стрелките, Enter copy и `d` clear. Clipboard не се изчиства автоматично: използвай само synthetic данните. След clearing няма payload за повторно копиране.
7. Свий терминала до около 40 колони, после го разшири. Няма излизане извън viewport; при тесен екран част от metadata се clipping-ва, подробностите са в `/af-audit`.

## 2. Waived

1. Стартирай `waived --keep`, изпълни `/triage-ui-fill applied`, Enter.
2. Изпълни `/triage-ui-waiver`. Той само подготвя реалната `/af-task-triage-waive …` команда.
3. Натисни Enter; прегледай въпроса. Избери **Yes — authorize once** само за това synthetic addition.
4. В Fleet и `/af-audit`: source addition и review са `waived`, не `satisfied`. Baseline acceptance остава отворен. Няма автоматично task acceptance или бюджетна промяна.

## 3. Timeout

1. Стартирай `timeout --keep`, изпълни `/triage-ui-fill timeout`, Enter.
2. След bounded timeout отвори Fleet и audit. Статусът е `unavailable`, няма нови additions. Attempts/usage не се измислят като известна нула. Няма endless retry.
3. Ако включиш capture преди изпращането, viewer показва failed/unavailable result, не успех.

## 4. Oversized и viewer withholding

1. Стартирай `oversized --keep`, изпълни `/triage-ui-fill oversized`, Enter. В editor-а има 40961 ASCII bytes.
2. Fleet/audit показват `oversized_input`, нула нови provider calls и без additions. Viewer няма request, който никога не е изпратен.
3. За отделната viewer граница: включи capture от Fleet → `1` → `e`, върни се с `Esc`, `q`.
4. `/triage-ui-fill viewer-withheld`, Enter: 33792-byte task е валиден за consumer-а, но над viewer payload лимита.
5. В viewer request е `payload withheld or too large`, не truncation или възстановено съдържание. Copy request не копира нищо; малкият response остава отделно достъпен.

## 5. Stale/pending

1. Стартирай `stale --keep`, изпълни `/triage-ui-fill applied`, Enter.
2. След това `/triage-ui-fill stale`, Enter.
3. Fleet/audit: новото input не освобождава старите задължения; старото addition е `stale` и `task_transition_pending` е blocker. Process completion е unknown, не accepted.
4. Не използвай reset/waiver за този тест; целта е видимият pending fence.

## 6. Нов exact-action prompt — отделно C4 човешко наблюдение

```bash
node bin/test/helpers/task-triage-ui.mjs action --keep
```

1. Изпълни `/triage-ui-fill action`, после **Enter**. Самата команда само поставя прегледания synthetic текст. Не изпращай реални задачи и не използвай waiver/reset за този случай.
2. Ще получиш четири **отделни production въпроса**. Преди избора провери `Operation`, `Target` hash, различен `Action` ID, `Working directory (JSON)` с временния workspace и **цялото** съдържание между `BEGIN ACTION INPUT JSON` и `END ACTION INPUT JSON`. Не приемай hash или частичен preview за достатъчни подробности. Ако не можеш да прочетеш всичко, избери **No — deny** и съобщи BLOCK.
3. Подробностите и очакваните човешки решения са:

| Въпрос | Пълни synthetic inputs | Решение само след преглед |
|---|---|---|
| bash | `command: "printf 'synthetic bash preview\\n'"`, `timeout: 5` | Yes — authorize once |
| write | `path: "action-write.txt"`; `content: "synthetic write line 1\nsynthetic write line 2\n"` | Yes — authorize once |
| edit | `path: "action-edit.txt"`; **две** `edits`: `alpha-before` → `alpha-after`, `beta-before` → `beta-after` | Yes — authorize once |
| следващ отделен write | `path: "action-denied.txt"`; `content: "later action needs its own decision"` | **No — deny** |

4. `1`/`2` избира Yes/No, **Enter** потвърждава; не натискай Enter на сляпо. Използвай **PgUp/PgDn** за prompt-а. При collapsed context следвай показания `expand context` shortcut. Свий терминала при edit въпроса (например 48 колони), разгледай и двете замени и крайната JSON граница, после разшири. Връщането към широк екран не дава разрешение само по себе си. **Esc** отменя въпроса.
5. След четвъртия въпрос следват две автоматично отказани write заявки: `action-sensitive.txt` с фиксиран **фалшив** `password=synthetic-only-action-sentinel` и `action-large.txt` с 20000 `x` символа. Те не трябва да отворят Yes/No prompt или да създадат файл; Pi може да показва заявката в стандартния tool transcript, който е отделен от metadata audit. В този личен сценарий няма ESC-control payload, за да не разстройва terminal renderer-а; control refusal е проверен отделно в automated authority/RPC тестове.
6. Изчакай `Fixed action sequence finished`. `/triage-ui-action-status` трябва да показва `write: exact expected bytes`, `edit: exact expected bytes`, а `denied`, `sensitive`, `large`: `missing`. Status е read-only проверка на фиксираните временни файлове; **не е** човешки или независим verdict. Ако откажеш/отмениш някое от първите три действия, очакваните bytes за него естествено няма да са налични — запиши какво си избрал.
7. `/af-audit`: отделни grant/consumption/result факти; следващите ефекти още изискват confirmation. Няма semantic task acceptance. Action metadata не трябва да съдържа content или сурови paths; обикновеният Pi transcript има различна privacy граница.
8. `/quit` излиза. `--keep` пази synthetic файлове/записи в **действително показаната** директория; fixture използва `--no-session`, не обещава persistent Pi transcript или screenshot. Не споделяй други terminal tabs/credentials.

Това е local-only **test fixture** с изолирани HOME/agent настройки и no-network guard. Production confirmation не е обещано local-only: съществуващият настроен ask-user local/remote **human** канал може да получи точни command/path/content подробности. 8 KiB е cap на пълния action detail block, не гаранция за четимост на всеки терминал или remote rendering. Липсващи/опасни/oversized inputs отказват grant **без truncation или partial redaction**. Sensitive detection е heuristic, не пълна гаранция.

## Запис на човешкото наблюдение

Попълни в отговора или отделен review artifact:

| Случай | Видян лично? | PASS / BLOCK / НЕПРОВЕРЕН | Бележки / запис |
|---|---|---|---|
| Applied / capture / copy / clear | | | |
| Waived | | | |
| Timeout | | | |
| Oversized / viewer withholding | | | |
| Stale / pending | | | |
| Тесен и широк терминал | | | |
| **Нов C4:** bash command/timeout + cwd | | | |
| **Нов C4:** write path/пълно content + cwd | | | |
| **Нов C4:** edit path/двете замени + narrow/wide + край на JSON | | | |
| **Нов C4:** отделен No, sensitive/oversized refusal и file status | | | |

Ако са налични, посочи OS/терминал, проверена ревизия и действителните директории, които launcher-ът е запазил. Не измисляй липсващи metadata, timestamps или screenshots. Screenshot/terminal recording трябва да съдържат само synthetic fixture данни, не други терминални tabs/credentials. Не се изисква публикуване на clipboard или сурови payloads. Ако не е видяно лично, запиши **НЕПРОВЕРЕН**, не PASS.

Тази проверка не доказва live Jev accuracy, calibration, независим A1 review, universal remote effect coverage или release readiness. За новия случай 6 след лично човешко потвърждение остават отделно разрешен post-fix C4 review и окончателно maintainer техническо приемане. Старият C4 BLOCK не се променя от този checklist.
