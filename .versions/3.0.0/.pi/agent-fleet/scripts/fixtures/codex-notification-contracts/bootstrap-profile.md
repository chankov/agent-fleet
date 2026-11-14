# Отделен prospective bootstrap contract profile

`codexNotificationBootstrapSurface()` има идентичност
`fleet-codex-notification-bootstrap/v1`, различна от current-consumer
`fleet-codex-notification/v1`. Запазва 12-те request/response roots, като добавя единствено
`thread/read` metadata `thread.path` като **optional nullable string**. Schema coverage
не обещава, че runtime path съществува, е четим или сочи rollout на този thread.
Missing/null/unsafe path трябва да блокира бъдещия driver, без hydrate/resume fallback.
Това е prerequisite profile за бъдещия probe driver, не завършена runtime интеграция.

`bootstrap-profile-0.167.json` е independently recaptured от двата вече налични offline
експорта 0.167.0/0.167.1. Резултатите съвпадат; 14 full-source hashes са същите като в
`notification-profile-0.167.json`, включително първоначалните 11. Използван е пълният
`ThreadReadResponse` schema body за parent assertions/path dependencies; останалите
reference documents са същите bounded captured fragments/envelopes. Това са schema
данни, не transcript съдържание. Старите fixture, проекции и fingerprints са непроменени.

Fingerprint: `cf611f03213d2306972768f8b00c6628ecba67cadc7e3de947eb3bb6764a06ff`.
Qualification: **not_qualified**. Няма нов qualified fingerprint, Desktop/executable/loaded
consumer доказателство, no-load capability, runtime admission или разрешение за probe.
`codexNotificationBootstrapPolicy(trustedReferenceDocuments)` ползва одобрените floors
и празни denylists/verifiedFingerprints; policy/reference не се приемат от model/tool args.
Compatibility preflight с този reference остава `contract_checked` + requiresProbe,
activation `not_performed`; не създава identity, consent или readiness.

Capture helper запазва input/UTF-8/byte guards от current capture, съпоставя повторно
прочетения ThreadReadResponse hash и отказва source drift. Не измисля path schema и не
strip-ва parent assertions; липсващ/unsupported path schema или непознат parent assertion
fail-ват затворено. Известният v1 profile продължава да покрива само старите consumers.

Четири добавени offline tests (11 profile общо) покриват distinct identity/current-v1
invariance, nullable/optional/missing/malformed path schema, запазени parent assertions,
source drift, detached policies и липса на qualification/read capability. Synthetic
reconstructed source bytes са изрично различни от оригиналните измерени hashes.

Source-only review `hub-scout-2a007010-127d-470a-90ba-e128a8ebe38b` не потвърди дефект;
parent провери пет snapshot/current hashes. Reviewer е прочел sources/tests/docs, но само
първите40 реда от generated JSON, не целия fixture въпреки по-широкия return; не е проверил
независимо raw provenance или изпълнил tests. Parent сравни пълните двукратни captures и
проекции/hashes; current profile е pinned непроменен. Reviewer е търсил DoD по погрешен
nested path; parent е прочел canonical references/definition-of-done.md. Final regression:
433/433 targeted17,979/979 fast47+932/113files,scoped strict TS,manifest103,whitespace green.
Това е ограничено source/capture evidence, не qualification или readiness.
