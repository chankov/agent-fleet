import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { MonitorRegistry } from "./hermes-monitor-registry.ts";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "agent-fleet-monitor-registry-"));
}

test("registry canonicalizes profiles and isolates simultaneous hub namespaces", () => {
	const root = fixtureRoot();
	const profileA = join(root, "profile-a");
	const profileB = join(root, "profile-b");
	mkdirSync(profileA);
	mkdirSync(profileB);
	symlinkSync(profileA, join(root, "profile-a-alias"));
	const registry = new MonitorRegistry({ runtimeDir: join(root, "runtime") });
	const first = registry.register({ profilePath: profileA, hubInstanceId: "hub-a", snapshot: () => ({ tasks: ["a"] }) });
	const sameProfile = registry.register({ profilePath: join(root, "profile-a-alias"), hubInstanceId: "hub-b", snapshot: () => ({ tasks: ["b"] }) });
	const otherProfile = registry.register({ profilePath: profileB, hubInstanceId: "hub-a", snapshot: () => ({ tasks: ["c"] }) });

	assert.equal(first.profileKey, sameProfile.profileKey);
	assert.notEqual(first.namespacePath, sameProfile.namespacePath);
	assert.notEqual(first.namespacePath, otherProfile.namespacePath);
	assert.deepEqual(first.snapshot(), { tasks: ["a"] });
	assert.deepEqual(sameProfile.snapshot(), { tasks: ["b"] });
	assert.deepEqual(otherProfile.snapshot(), { tasks: ["c"] });
});

test("registry renews owner-only discovery lease atomically without replacing its token", () => {
	const root=fixtureRoot(), profile=join(root,"profile"); mkdirSync(profile); let now=new Date("2026-01-01T00:00:00Z");
	const registration=new MonitorRegistry({runtimeDir:join(root,"runtime"),now:()=>now,leaseMs:1000}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});
	const first=JSON.parse(readFileSync(registration.discoveryPath,"utf8")); now=new Date("2026-01-01T00:00:00.500Z"); registration.renew(); const renewed=JSON.parse(readFileSync(registration.discoveryPath,"utf8"));
	assert.equal(renewed.lease.startedAt,first.lease.startedAt); assert.notEqual(renewed.lease.expiresAt,first.lease.expiresAt); assert.equal(registration.leaseMs,1000);
	registration.cleanup(); assert.throws(()=>readFileSync(registration.discoveryPath),/ENOENT/);
});

test("paused stale renewal cannot recreate discovery after replacement claims the namespace",()=>{const root=fixtureRoot(),profile=join(root,"profile");mkdirSync(profile);let now=new Date("2025-01-01T00:00:00Z"),replacement:any;const registry=new MonitorRegistry({runtimeDir:join(root,"runtime"),now:()=>now,leaseMs:1,beforeRenewPublish:()=>{now=new Date("2025-01-01T00:00:02Z");replacement=registry.register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});}});const stale=registry.register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});assert.throws(()=>stale.renew(),/ownership lost/);assert.deepEqual(readdirSync(replacement.namespacePath).filter(x=>x.startsWith("discovery-")),[basename(replacement.discoveryPath)]);});

test("registry fails closed without deleting structurally invalid discovery metadata",()=>{const root=fixtureRoot(),profile=join(root,"profile");mkdirSync(profile);const registry=new MonitorRegistry({runtimeDir:join(root,"runtime")});const first=registry.register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})});writeFileSync(first.discoveryPath,"{}");assert.throws(()=>registry.register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})}),/malformed/);assert.equal(readFileSync(first.discoveryPath,"utf8"),"{}");});

test("expired cross-owner discovery cannot delete another owner's token or socket",()=>{const root=fixtureRoot(),profile=join(root,"profile");mkdirSync(profile);let now=new Date("2025-01-01T00:00:00Z");const r=new MonitorRegistry({runtimeDir:join(root,"runtime"),now:()=>now,leaseMs:1});const a:any=r.register({profilePath:profile,hubInstanceId:"a",snapshot:()=>({})}),b:any=r.register({profilePath:profile,hubInstanceId:"b",snapshot:()=>({})});now=new Date("2025-01-01T00:00:02Z");const forged=JSON.parse(readFileSync(a.discoveryPath,"utf8"));forged.token=`token-${JSON.parse(readFileSync(b.discoveryPath,"utf8")).owner}`;forged.socket=`@runtime/s/${b.socketDir.split("/").pop()}/s`;writeFileSync(a.discoveryPath,JSON.stringify(forged));assert.throws(()=>r.register({profilePath:profile,hubInstanceId:"a",snapshot:()=>({})}),/malformed/);assert.equal(existsSync(b.socketDir),true);assert.equal(existsSync(join(b.namespacePath,forged.token)),true);});

test("registry rejects traversal and symlink roots and creates owner-only token namespaces", () => {
	const root = fixtureRoot();
	const profile = join(root, "profile");
	mkdirSync(profile);
	const registry = new MonitorRegistry({ runtimeDir: join(root, "runtime") });

	assert.throws(() => registry.register({ profilePath: profile, hubInstanceId: "../other", snapshot: () => ({}) }), /hub instance id/);
	const registration = registry.register({ profilePath: profile, hubInstanceId: "hub-a", snapshot: () => ({}) });
	assert.equal(registration.namespaceMode, 0o700);
	assert.equal(registration.tokenMode, 0o600);
	assert.match(registration.token, /^[a-f0-9]{64}$/);

	const symlinkRoot = join(root, "runtime-link");
	symlinkSync(join(root, "runtime"), symlinkRoot);
	assert.throws(() => new MonitorRegistry({ runtimeDir: symlinkRoot }), /must not be a symlink/);
});
