import type {BootstrapNamespace} from './fleet-notification-bootstrap.ts';
import type {TargetEpoch} from '../../agent-fleet/scripts/lib/fleet-codex-allowlist.ts';
export type ConnectionTransition={stage:string;at:number;deadline?:number;reason?:string;probeId?:string};
export type ConnectionDiagnostic=ConnectionTransition&{namespace:BootstrapNamespace;owner:TargetEpoch;attemptId:string};
export type ConnectionAttempt={attemptId:string;owner:TargetEpoch;transitions:ConnectionTransition[]};
export type ConnectionHistorySnapshot={scope:'historical_only';status:'available'|'missing'|'unavailable';attempts:ConnectionAttempt[]};
export const safeDiagnosticReason=(reason:string)=>/^[a-z][a-z0-9_]{0,95}$/.test(reason)?reason:'diagnostic_redacted';
