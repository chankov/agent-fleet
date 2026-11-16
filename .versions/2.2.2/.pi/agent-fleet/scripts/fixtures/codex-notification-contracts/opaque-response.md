# Kernel prerequisite — required opaque response presence (дял 8b)

Потребителят прие дял 8a с „Одобрявам — продължи“ и разреши отделен малък kernel дял само за
explicit opaque/presence support за response `result:true`, със запазена requiredness и
отказ на unsupported constraints. Няма разрешение за open sent properties, general schema
support, full profile/admission или live операции. Profile дял 8 остава отложен.

## Договор и решения

- Нов explicit `UsedShape` selector `{type:'opaque'}`. Това **не** е JSON Schema type;
  actual schema `{type:'opaque'}` продължава да се отказва. Използваме съществуващия type
  discriminator без нов filename/property-name hack или автоматична schema inference.
- Selector-ът има само `type` key и важи единствено за required response property с direct
  literal boolean schema `true`. Parent object запазва existing required/property checks.
  Private traversal context доказва, че това е required response property, не root/items.
- Request, root, array items, optional response property, type unions с opaque, fields/items/
  literal/variant/sent/optional controls се отказват. Обикновен typed selector не придобива
  право да приема `true`. Следователно typed method-payload проверките остават отделни.
- Ref/allOf/anyOf wrappers, schema false, empty/typed schema objects, constraints/scopes и
  всяко non-true значение се отказват като unsupported_opaque_schema. Няма stripping на
  assertion или general boolean-schema engine; дори еквивалентен `{}` не е включен.
- Projection marker е `{type:['opaque'],constraints:{}}`. Пази само наличието, **не** payload
  type, структура, стойност, identity или authority. Пълен бъдещ profile трябва отделно да
  покрива typed payload roots и съответствието им с method/id; това още не е реализирано.
- Format/domain остава v1. Досега този selector се отказваше с type_required; предишните
  успешни inputs/outputs/hashes са непроменени, включително pinned 10-root reference hash.
  Няма нов qualified fingerprint, trusted profile, minimum default или admission caller.

## Проверки

- Преди edit pure reproduction на required result:true с opaque selector отказа type_required.
- След edit оригиналният offline 0.167.1 JSONRPCResponse envelope се проектира с id primitive
  union/int64 и required opaque result. Не е правена binary/socket/live операция.
- 6 нови теста: presence marker; missing required/property и optional отказ; non-true/constraints
  отказ; request/root/items/selector escape guards; typed-payload/open-sent guards; frozen/
  detached output. Negative fixture запазва explicit undefined, вместо да го подменя с true.
- 25 projection + 15 assessment tests; broad matrix **303/303** в 11 файла.
- **912/912** fast = 47 bounded + 865 parallel, 109 файла, без fail/skip.
- Strict kernel/test/assessment TypeScript; manifest103; whitespace. CI registration и
  installed shared-lib tree са съществуващи; няма нов command/item/permission.
- Original initialized.params={} reproduction продължава да отказва used_field_missing;
  open sent request support остава отделен, неразрешен prerequisite.

Source-only review `hub-scout-5935311e-efbd-40f8-b149-6432090c3dfd` прочете kernel1–240,
тест60–360, този документ, projection10–44 и surface45–70; няма потвърден дефект. Reviewer
не е изпълнявал независимо тестове/commands. Parent провери **шест** snapshot/current SHA256
съвпадения: kernel, тест, този документ, projection/surface и 0.167-shared fixture. След
единствената test-title корекция също са повторени зелените 303/912/strict/manifest/whitespace
runs. Финалният review/results appendix е parent-only metadata update. **Дял 8b е приет** с „Одобрявам — продължи“; потребителят изрично поиска
status/име на плана, после compaction и продължаване само след нея. Разрешен е отделен 8c за
действително изпращани request fields, разрешени от open additionalProperties, с fail-closed
requiredness/constraints и непроменени стари projections/hashes. Без general boolean/root
schemas, full profile/admission, qualification или live операции. 8c не е започнат преди compaction.

Рискът е разширеният schema contract, не нови права/активация. Opaque presence не е достатъчно
за compatibility/readiness или qualification; full profile, real consumer/probe evidence и
authority gates остават отделни. Няма staging/commit, branch/pull или live промени.
