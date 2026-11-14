# Kernel prerequisite — bounded primitive response anyOf (дял 8a)

След profile-only inventory потребителят изрично разреши **„Да — отделен малък kernel дял“**:
само bounded disjoint primitive response-anyOf support. Това не приема незавършения дял 8
и не разрешава opaque/presence schema или open sent request-field support. Няма runtime
admission, qualification, нови qualified fingerprints, минимални defaults или live операции.

## Договор и рутинни решения

`codex-contract.ts` допуска response `anyOf` с 1–5 branches, всяко с един primitive type.
Допустимите типове са string, integer, number, boolean, null. Всички branches трябва да са
в обработваните от caller-а типове; за разлика от request selection не избираме само удобен
branch. Duplicate types и integer/number overlap отказват, дори constraints да изглеждат
disjoint. Не решаваме enum/range disjointness и не разширяваме general JSON Schema support.
Object/array, nested anyOf, multi-type branches, literal/variant selectors и непознати used
assertions остават fail-closed. Existing local refs/singleton allOf/bounds продължават да важат.

Всички branch assertions се проектират със съществуващия primitive projector. Без assertions
union се нормализира към съществуващата flat type-set node форма (напр. string|null). Иначе
се пазят отделни `anyOf` branch nodes, deterministic sorted по bounded canonical JSON с
code-unit comparison, не locale. Не се factoring-ват ограничения между различни типове.
Format/domain остава `fleet-codex-projection/v1`: досега използван response-anyOf се отказваше,
а всички предишни успешни inputs/outputs запазват алгоритъма си. Няма промяна на comparator,
request-anyOf selection, version policy, authority или production profile.

Преди промяната operator VM върху съществуващия test preamble измери стария 10-root projection
hash `5e63613f5b517437753f6f73b286eb289d7de5896c67c895eabab4fcdc725472`.
Той е pinned regression assertion, **не qualified fingerprint**. Реалният captured
ClientRequest.RequestId от 0.167-shared fixture вече се проектира като response и запазва int64.
Original 0.167.1 JSONRPCResponse.id reproduction преди промяната отказа unsupported_anyof;
opaque result и open initialized.params остават отделни blocker-и за пълния profile.

## Проверки

6 нови теста; общо 19 projection теста. Старият nullable nextCursor anyOf refusal е преместен
в положителен same-projection тест за новия разрешен случай — не е премахнато покритието.
Проверени са branch order/ref/allOf/annotations, всички branch types, numeric overlap,
branch constraints, missing/unknown types, max count преди iteration, frozen/detached inputs,
и непроменен отказ за двата неразрешени prerequisites.

Първият run имаше 1 fixture failure: singleton-allOf wrapper премести definitions под wrapper,
въпреки че local refs остават document-root относителни. Definitions са оставени на root,
без отслабване на resolver-а. След поправката: 297/297 targeted в 11 файла, 906/906 fast
(47 bounded + 859 parallel, 109 файла), strict TypeScript за kernel/tests/assessment test,
manifest check 103 items, whitespace. Финалните measured-ID/before-iteration/numeric-overlap
assertions са включени в повторените зелени runs със същите 297/906 резултати. Original offline
JSONRPCResponse.id също вече се проектира с int64, а result:true продължава да отказва.
Parent adversarial проверка намери defensive sparse-array пропуск: map skip-ваше holes,
което при unconstrained union можеше да даде flat projection без branch validation. Pure
reproduction го потвърди. След max-count guard се ползва Array.from (max5); добавени са
sparse и mixed-sparse negative assertions. След тази поправка отново 297/297 targeted,
906/906 fast, strict TS, manifest103 и whitespace са зелени. Няма broad exception promise
за произволни getters/Proxies; supported input остава inert JSON.

Първи source-only review `hub-scout-d217ca01-b7f4-483b-b61d-aa1fd227c319` прочете целия kernel,
тест 55–275, този документ и relevant projection/surface бележки, без потвърден дефект.
Не е изпълнявал тестове. Review snapshot е преди Array.from/sparse-test промяната;
тези две source версии не се представят за свежо reviewed.

Фокусираният follow-up `hub-scout-760a825a-0165-49e2-9f2e-19e35df966b3` прочете final kernel
99–160, тестове 199–285, целия този evidence документ и projection.md15–40, без потвърден
дефект. Първият преглед покрива останалия непроменен kernel. Parent провери **шест** current/
snapshot SHA256 съвпадения: kernel, тест, този документ, projection/surface docs и captured
0.167-shared.json. Source/test mismatch спрямо първия snapshot е потвърден и не е скрит.
Reviewers не са изпълнявали независимо тестове/commands; 297/906 е реалният parent run,
не независимо потвърждение или live evidence. Финалният review/results appendix е parent-only
metadata update. Потребителят прие дял 8a с **„Одобрявам — продължи“** и разреши само отделен
дял 8b: explicit response opaque/presence result:true support със запазена requiredness и
отказ на unsupported constraints. Няма разрешение за open sent properties, general schema
support, full profile/admission или live операции; следващият user gate остава задължителен.

Рискът е в разширения supported-schema договор. Kernel-ът е offline и няма production caller/
qualified profile, но не бива да се третира като доказателство за Desktop identity, capability,
доставка, permissions или readiness. Дял 8/profile остава отложен до другите предпоставки.
