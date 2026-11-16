import type {StoreSnapshot} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist-store.ts';
import type {TargetEpoch} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist.ts';
import type {BootstrapRights} from './fleet-notification-bootstrap.ts';
/** Pure same-namespace snapshot. Exact epoch mismatch never inherits readiness. */
export function codexRightsSnapshot(state:StoreSnapshot|null,owner:TargetEpoch):BootstrapRights {
 const binding=state?.bindings.find(b=>b.target.project===owner.project&&b.target.peer===owner.peer);
 return {revision:state?.revision??0,rights:binding?[...binding.rights]:[],
  status:binding?(binding.target.sessionId===owner.sessionId&&binding.target.startedAt===owner.startedAt?binding.status:'target_changed'):'not_connected',
  ...(binding?.expiresAt===undefined?{}:{expiresAt:binding.expiresAt})};
}
