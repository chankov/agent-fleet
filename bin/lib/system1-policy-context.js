// CLI policy context uses the same root runtime as Hub, without importing TypeScript.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolvePolicyRoots, resolveRuleBinding } from '../../.pi/harnesses/lib/policy-roots.js';
import { safeSourceRead } from '../../.pi/harnesses/lib/safe-source-read.js';

export function reviewedPolicyRoots(workspace, text) {
 const config = { rulesDirs: [], docsPaths: [] };
 let inHub = false;
 for (const raw of (text ?? '').split('\n')) {
  const line = raw.replace(/\r$/, ''), heading = line.match(/^##\s+(.+?)\s*$/);
  if (heading) { inHub = ['agent-hub', 'agent-team'].includes(heading[1].trim().toLowerCase()); continue; }
  if (!inHub) continue;
  const pair = line.match(/^\s*([a-zA-Z][\w.-]*)\s*:\s*(.+?)\s*$/);
  if (!pair) continue;
  const key = pair[1].toLowerCase();
  if (key === 'rules' || key === 'docs') config[key === 'rules' ? 'rulesDirs' : 'docsPaths'] = pair[2].trim().split(',').map(s => s.trim()).filter(Boolean);
 }
 return resolvePolicyRoots(workspace, config);
}
export function loadReviewedPolicyRoots(workspace) {
 let text;
 try { const root = realpathSync(workspace); text = safeSourceRead(root, join(root, '.ai/agent-fleet-overrides.md'), 1024 * 1024).toString('utf8'); }
 catch { /* Missing/unsafe overrides authorize no external sources. Doctor reports config errors separately. */ }
 return reviewedPolicyRoots(workspace, text);
}
/** Static pin diagnostics only, not turn evidence or a successful consumer review. */
export function proactiveBindingDiagnostics(snapshot, roots) {
 const bindings = snapshot.consumers.proactiveReview.config?.localBindings ?? [];
 const findings = [], cache = new Map();
 let bytes = 0;
 for (const binding of bindings) {
  let reason;
  try {
   const source = resolveRuleBinding(roots, binding.rule.path);
   let text = cache.get(source.path);
   if (text === undefined) {
    if (cache.size >= 64) throw new Error('binding_budget');
    const content = safeSourceRead(source.root.kind === 'file' ? roots.workspace : source.root.canonicalPath, source.path, 256 * 1024 - bytes);
    bytes += content.length; text = content.toString('utf8'); cache.set(source.path, text);
   }
   if (createHash('sha256').update(text).digest('hex') !== binding.rule.hash) reason = 'unverified_binding:stale_hash';
   let occurrences = 0, fence = false;
   for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[2].trim() === binding.rule.heading) occurrences++;
   }
   if (occurrences < binding.rule.occurrence) reason = 'unverified_binding:missing_heading_occurrence';
  } catch (error) {
   reason = error.message.startsWith('ambiguous_binding:') ? 'ambiguous_binding' : 'unverified_binding:source_unavailable';
  }
  if (reason) findings.push({ type: 'system1-binding', path: binding.rule.path, classification: 'advisory', issue: `Proactive binding: ${reason}; consumer evidence remains unverified`, fix: 'review source identity, heading and pinned hash explicitly; no automatic repin' });
 }
 return findings;
}
