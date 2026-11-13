# Bootstrap connection channel — integrated, not host-qualified

Отделният duplex `bootstrap_channel` използва съществуващия registry connection socket. Legacy one-shot RPC остава с 1500ms budget. При конфигуриран нов bootstrap AF отказва legacy notification prepare/commit с `bootstrap_protocol_required`; няма downgrade fallback. Отделните исторически rights-only API не се превръщат в notification consent и не издават admission.

AF `BootstrapChannelServer` не мутира allowlist. `CodexBootstrapProducer` в native MCP процеса е writer на точно namespace/owner/binding/hostInstance, canonical rights/common deadline и revision, чрез create-only connect или explicit reconnect с old-target CAS. Един нов native channel writer не е гаранция срещу злонамерен същия UID или неподчиняващи се стари процеси: quiescent old writers е показан човешки prerequisite, не измислен model boolean.

Има owner-bound singleton, ограничени 32 live links, осем pending RPC/link, 32KiB frame, bounded rolling recent IDs/backlog и сериализация на writes за namespace. Public proposal cache е bounded и current-chat scoped, с 5min lifetime/shared legacy budget. Native observations са свежи до 10min; explicit refresh идва от валиден native context. След точно потвърдени права живият channel може да обслужва **същия** lease до общия срок (максимум 720h), без stale presence да разрешава нов grant. Socket сам не е authority.

Commit RPC budget до 240s е вътрешен transport budget. **Public native commit връща `pending`**, а не държи Model/tool turn отворен докато очаква terminal ACK от същия чат. Pending не доказва съгласие, права, readiness или доставка. Нормален MCP response не abort-ва call signal; предходна отмяна и producer shutdown остават действащи. Duplicate не изпраща нов commit; cached terminal result е стар receipt, не текущ status.

Writer response се чака максимум 4.5s (<coordinator 5s). Disconnect/expiry/disable/reset/stop отменят scoped jobs/writer signals; EOF спира bootstrap и пази bounded drain за unrelated legacy calls. Namespace-scoped commit/cancel не приема чужд proposal. Registry endpoint inode и fresh candidate се проверяват преди attach. Нов AF epoch не получава автоматично старата authority.

Presence/rendezvous файловете са частни, ограничени observations: namespace/MCP instance, реално initialize/clientInfo и served tools/list, timestamp; не са Desktop identity, loaded-consumer capability или човешко съгласие. AF read-only prepare установява отделно действителния process mapping, каталог и no-load capability. Renderer/status/cache refresh не правят daemon probe/grant/activation. Safety watcher е отделен и може да pause-не преди bytes; bounded same-fingerprint continuation използва оригиналния Pi scope и срок, без Codex policy writer.

Преди rename отказът не публикува нови права. След възможна publication резултатът може да е unknown, не rollback/success/replay. Отдалечена отмяна се вижда след transport propagation; native writer recheck-ва signal/context преди публикация. Process-local admission не може да се възстанови от JSON.

## Evidence boundaries

Първите осем owned UNIX-endpoint tests + 91 legacy role/control/store checks (99/99) бяха foundation evidence с fake probe/activation callbacks. Това не се преименува на production Desktop evidence.

Текущите production adapters имат допълнителни owned fake-proc/WS/native-socket/rollout/CLI интеграционни проверки за едно Pi решение, unknown/no-replay, pending handoff, stable cold journal, drift и conditional continuation; root/UI wiring вече съществува. Независимите review reports уточняват действително прочетения/изпълнен scope. Няма реална Desktop/historical qualification или разрешение за live effects. Виж [текущия договор и отделно разрешен preflight](../../../../../docs/codex-notification-bootstrap.md).
