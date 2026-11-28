import {createHash} from 'node:crypto';
import {actionPresentation} from './action-presentation.ts';

/** Trusted dialog only. Validate the full input, but never render edit/write bodies. */
export function approvalTarget(operation:string, cwd:string, input:unknown):string|null {
 const serialized=JSON.stringify(input);
 if (!serialized) return null;
 const target=createHash('sha256').update(serialized).digest('hex');
 const detail=actionPresentation({operation,cwd,target},{input,cwd});
 if (!detail || operation==='bash') return detail;
 const path=(input as {path?:unknown}).path;
 return typeof path==='string' && path.trim() ? JSON.stringify(path) : null;
}
