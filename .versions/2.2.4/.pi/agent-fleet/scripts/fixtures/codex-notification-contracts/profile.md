# Current notification consumer ABI — offline reference, НЕ qualification

Потребителят прие8c и изрично поиска работа по оставащите фази без междинни одобрения,
с вътрешни code reviews и отстраняване на находките. Main/no git writes и без real Codex/
socket/queue/probe/transcript/activation/config/grant операции остават; Phase5 няма ново
разрешение. Нерешени material decisions/permissions не се заместват с model consensus.

## Точно покритие

`codexNotificationSurface()` е pure detached factory с identity fleet-codex-notification/v1.
12 roots/8 used files покриват текущите queue host и initialize-only observer:
- queue initialize experimentalApi:true и observer initialize:false с действителните clientInfo;
- initialized.method + действително изпращаното params:{};
- success/error JSONRPC id primitive unions, required opaque result, error presence/object;
- initialize.userAgent, thread/read metadata id/status.type notLoaded, includeTurns:false;
- queue/add sent text input/clientUserMessageId и returned submission id/input.type/text;
- queue/list cursor/limit100 и data/submission/clientUserMessageId/input.type/text/optional cursor.
loaded/list има whitelist entry, но няма текущ notification caller; не измисляме payload.
ServerNotification payloads са игнорирани. Future transcript probe/bootstrap още НЕ са
покрити от **този** v1 profile. Отделният [prospective bootstrap profile](bootstrap-profile.md)
добавя само optional nullable thread.path с различна identity/reference, без да променя
този v1 или да обявява driver/read capability/qualification. Следващ consumer изисква
изрично съответстващо coverage преди readiness claim.

Known sent text_elements:[] използва ограничен request literal:[]; не валидира непращани
TextElement items. Това е необходимо за used-only projection, не нов general schema engine.
Само exact empty request array, без items selector; array-level assertions/enum/const се
пазят, minItems>0 отказва. Nonempty/sparse/object/response literal и root schema:true отказват.
Всички стари successful projections/v1 hashes са непроменени. Няма qualified list.
След отделен material въпрос потребителят изрично избра production floors daemon0.166.0 и
Desktop0.166.0-alpha.5.1, начални denylists[]. codexNotificationPolicy(referenceDocuments)
връща detached server-owned policy с тези floors и verifiedFingerprints:[], без ready или
activation. Trusted referenceDocuments идват от package/capture, не от model/tool args.

Runtime guards са съгласувани с профила: reconciliation изисква реален input array и type:text,
не различен вариант с text lookalike. Legacy RPC вече отказва nonobject/binary frames/invalid
UTF8, игнорира method-bearing server requests без reply и отказва own error дори false.
Тези guards не въвеждат approval/queue tool, replay, new tuple или старт на daemon. Тестове
ползват само owned fake UNIX servers. Съществуващият TS2339 turnId assertion е възпроизведен
на original HEAD145; в разширения test е добавен type-only cast без runtime промяна. Другите
legacy MCP readonly fixture errors не са променяни.

## Raw provenance и fixture

`capture-profile.ts` е bounded offline helper (16MiB/file,32MiBtotal), strict UTF8, private
byte copies, без FS/process/runtime calls. Старите11 source hashes/fragments не са променени.
Добавя3 envelope hashes и реконструира само captured schema fragments + пълни envelopes.
Това НЕ възстановява липсващите исторически schema bodies. Synthetic capture tests са ясно
отделени от measured raw bytes.
`notification-profile-0.167.json` е възпроизведен независимо от двата СЪЩЕСТВУВАЩИ offline
Linux CLI exports0.167.0/1, без нов binary run;14 hashes,12 roots,8 used files,72865 bytes.
Unqualified fingerprint: aac9af961f496998b8cccd4f1eeecd2a40985733011073c5b6d589815adafb99.
qualification е not_qualified. Това не е Desktop executable/MCP consumer identity или probe.
Няма нов qualified fingerprint/tuple/policy, runtime admission, minimum или activation.

Guarded exportSchema вече връща9 roots: предишните6 плюс ClientNotification,JSONRPCResponse,
JSONRPCError. Същите ownership/inode/bytes/version/budget/cleanup checks; няма нова команда.
Липсващ envelope отказва export вместо мълчалив стар непълен subset. Само fake executable tests.

## Проверки

35 kernel tests (4 нови empty-literal),6 нови profile/capture/mutation/preflight tests,
5 нови queue guard tests и1 missing-envelope export test. Profile/queue са в fast lane.
Strict TS за новите/променени sources/tests е зелен след type-only fixture correction.
Преди новия policy-floor test:325/325 targeted12,947/947 fast47+900/111files,strict/manifest103/
whitespace. Reviews9a9fc91a и6e695098 са source-only без потвърден дефект/без независими tests.
Parent провери7+7 snapshot/current hashes. Първият review не провери независимо raw fixture
provenance/consumer emitters (ограничението е изрично); parent сравни двата raw export capture
резултата и фактическите initialize constants, вторият прегледа runtime emitters/guards.
Новите policy-floor edits изискват отделно follow-up review; първите reports не го покриват.
Phases0/1 още не са complete: исторически/actual Desktop evidence и live probe липсват.
