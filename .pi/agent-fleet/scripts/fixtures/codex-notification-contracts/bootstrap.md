# AF bootstrap coordinator — core evidence and guarded production integration

**Текущ статус:** presence/duplex writer, explicit Desktop preflight, concrete pinned probe, private admission/config/runtime и Fleet View вече са вързани. Native public commit е `pending` handoff, за да освободи текущия model turn. Conditional D7 continuation пази стария common lease/journal/rights. Виж [channel](channel.md) и [текущия договор](../../../../../docs/codex-notification-bootstrap.md). Няма текуща Desktop/historical qualification или live разрешение.

## Историческа foundation evidence (следващите описания са за core increment)

Потребителят изрично поиска whole-plan execution без междинни phase approvals, с вътрешни
code reviews/корекции. Отделно реши production floors daemon0.166.0,Desktop0.166.0-alpha.5.1,
начални denylists[]. Version policy е server-owned, не model/tool args; no qualified list.

При foundation checkpoint `NotificationBootstrap` беше bounded AF-side orchestration с injectable TRUSTED adapters, без production driver. Това е историческият scope, не текущо твърдение, че интеграцията още липсва; source integration не е моделно доказателство или разрешение за host side effects. [Локалният reader](probe-reader.md), [CAS reconnect primitive](reconnect.md) и
[отделният bootstrap path profile](bootstrap-profile.md) са имплементирани и synthetic-tested,
и впоследствие са свързани към guarded production controller/admission; реалната capability/identity остава отделна проверка.
Няма ново live/Phase5 разрешение; missing actual Desktop/no-load reader evidence остава gap.

- prepare е read-only inspection; cached rows/status не викат adapters, няма config/grants/probe.
- Mandatory validated host context/current28-tool catalog/nonblocked assessment + server-owned
  **verified_without_loading** read capability. Missing/unavailable отказва още преди Pi UI.
  Capability не се извежда от UA/schema или model flag; production default не се измисля.
- One native Pi confirmation показва namespace/AF owner/rights/lease, compatibility и D6 warning,
  model-turn cost и quiescent Codex writer requirement. Само explicit boolean true продължава.
- Fresh owner/epoch/context/catalog/rights snapshot checks преди/след awaits. Само CODEX adapter
  променя права, не AF AllowedSessionsStore writer. All rights имат едно until.
- Single probe с private nonce, exact thread/host/daemon/Desktop/socket context, readonly
  assistant transcript ACK и before/after notLoaded. Queue ACK не е model delivery.
- Atomic config/activation adapter е след правилния ACK и fresh rights/context; няма fallback
  при липсващ probe, self-report, wrong thread, stale owner, restart или timeout.
- One-shot commit, cached receipt (не текущ readiness), no automatic rights/probe/activation retry.
  Uncertain writer/activation effects се обозначават unknown, не fabricated success.
- Logical wall+monotonic proposalTTL5min; max16 jobs/max32 rows; capacity се резервира преди await.
  Same namespace има един active proposal. Epoch/restart/clock rollback invalidate consent.
- Disable/shutdown cancel child signals; pending probe/UI не могат да продължат до activate.
  Trusted adapters трябва сами да recheck signal/scope непосредствено преди външен write/publish;
  coordinator не е sandbox и не може да undo uncooperative/stuck effects. Unknown остава explicit.
- Input/output/callback/receipt aliases се отделят. Raw diagnostics/paths не се препращат.
  Крайният runtime трябва отделно да stop-не ingress на shutdown; coordinator.stop е без I/O.

Self-review fixes преди independent review: disable/late-activation gate; private input/owner/
receipt snapshot aliasing; concurrent reservation; truthfulness на uncertain effects; shutdown
cancellation; bounded diagnostics/row aging. Всички са implementation details в приетия plan.
15 synthetic tests: single-confirm ordering/no replay, decline, missing capability/identity/
catalog/blocked grade, after-confirm drift, disable abort, wrong ACK, unknown effects,
aliases, capacity, restart/clocks, synchronous overdue callback, shutdown, absent owner,
diagnostics и D6. Няма real daemon/socket/queue в тези tests (callbacks only).
Текущият core не е включен в production handler и не означава готова Фаза2/3.
