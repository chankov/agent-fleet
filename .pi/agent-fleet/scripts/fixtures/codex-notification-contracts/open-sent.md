# Kernel contract — open sent empty-object request property (дял 8c)

## Обхват и поведение

Потребителят прие 8b и разреши отделен 8c само за действително изпращани request properties,
разрешени от open additionalProperties, с fail-closed requiredness/constraints и непроменени
стари projections/hashes. След поискания status/checkpoint и manual compaction gate потребителят
написа „продължи“. Няма whole-plan opt-in, full profile/admission или live разрешение.

- Минималният реален случай е `initialized.params={}` от codex-unix-queue-rpc.ts. Избраният
  template е empty object (`type:object`, празни `fields`), без нов API selector/flag.
  По simplicity-first не добавяме speculative scalar/array/nested template engine.
- Fallback има само за недекларирано property, request direction, име в guaranteed `sent`,
  и parent additionalProperties absent/strict true. Source field ownership и името се
  проверяват; false/unsupported additionalProperties не могат да отворят fallback.
- Допускането на произволна стойност от open parent доказва приемането на конкретния empty
  object. Локално се проектира `{type:'object'}` през обичайните guards за selected template;
  това не подменя documents/raw exports и не е general true-schema resolver.
- Декларирано property **винаги** се проверява, включително optional params. Няма fallback
  при malformed/unsupported/typed constraint. Нов integer params се отказва; нови object
  assertions се запазват и compareProjection отказва променения used contract.
- Parent assertions/scopes/requiredness checks остават преди fallback. Нов required, който
  действително изпращаме, е допустим; required, който не изпращаме, се отказва както преди.
- Scalar/array/nested missing templates, unsent/response fields, root/items true schemas и
  direct declared true schemas остават unsupported. В частност бъдещо params:true може
  консервативно да се блокира: няма обещание за general schema equivalence/subtyping.
- 8a primitive union и 8b required opaque response guards са непроменени. Projection format/
  domain остава v1; не се променя никой предишен successful input/output/hash.

## Проверки и provenance

- Преди edit original offline0.167.1 initialized.params отказа used_field_missing. Същият
  root със само in-memory declared `{type:object}` params даде regression hash:
  `01f7d615e6168333faa1f820a9cbc21efe01f4c36d0deaac7fa320a0754bb66b`.
  Това е **неqualified regression hash**, не actual Desktop/production profile evidence.
- След edit и двата непроменени offline ClientNotification exports0.167.0/0.167.1 дават
  същия regression hash. Future optional integer/minProperties params се отказват/променят
  used contract. Не са изпълнявани binary/socket/queue/probe операции.
- 6 нови теста: implicit/explicit true; old declared-equivalent hash; declared schema wins;
  parent permission/scopes/requiredness; unsent/response/general template/control guards;
  assertion changes; frozen inputs/detached projection. Synthetic initialized fixture е
  изрично synthetic, не измерен raw body. Два стари open-field negative inputs вече задават
  explicit false и запазват closed-field guard-а; новото разрешено open поведение се тества.
- **31 projection +15 assessment**, **309/309** targeted в11 файла.
- **918/918** fast =47 bounded+871 parallel,109 файла, без fail/skip.
- Strict kernel/kernel-test/assessment-test TypeScript, manifest103 и whitespace са зелени.
  Existing 10-root hash `5e63613f…725472` е непроменен и остава неqualified.
- No new module/runtime caller/installed manifest item/command/permission/default minimum/
  qualified fingerprint. Fixed six-root exporter и runtime admission са непроменени.

Допълнителен parent pure synthetic preflight smoke: open template води само до
contract_checked/requiresProbe/activation:not_performed (verifiedFingerprints е празен).
Typed params, нов constraint и closed parent водят до blocked, не D6 fallback/readiness.
Това е offline integration check, не реално измерена Desktop съвместимост.

Source-only review `hub-scout-0d7b0780-5ecc-41d9-9ab4-7a8322330501` няма потвърден дефект.
Прочете kernel1–260, тест60–450, този документ, projection45–84 и consumer60–99; reviewer
не е изпълнявал независимо tests/code/commands. Parent провери шест snapshot/current SHA256
съвпадения: kernel, тест, този документ, projection, surface и 0.167-shared fixture (включва
untracked files). Code/tests са непроменени след review; този appendix и статусите са
parent-only metadata updates. **Дял 8c е приет.** Потребителят изрично поиска продължаване
без спирания между фазите, с вътрешно code review и реакция на находките. Междинните
slice gates са отменени; material decisions/permissions и live ограниченията остават.

Пълният used-surface profile е още незавършен; отстраняването на известна kernel
предпоставка не го квалифицира автоматично.
Comparator-ът пази constraints консервативно, не изпълнява общ schema value validator;
opaque envelope presence не замества typed payload, live consumer/probe или authority gates.
