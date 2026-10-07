import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PendingHandoff {
	target: string;
	token: string;
}

/**
 * Explicit access to composition-owned Hub state. The root owns every backing
 * binding; this context only exposes typed ports to extracted runtimes.
 */
export interface HubStateContext {
	getCurrentContext(): ExtensionContext | null;
	setCurrentContext(value: ExtensionContext | null): void;
	getExemptionsFile(): string | null;
	setExemptionsFile(value: string | null): void;
	getSessionDir(): string;
	setSessionDir(value: string): void;
	getWidgetContext(): any;
	setWidgetContext(value: any): void;
	getPendingHandoff(): PendingHandoff | null;
	setPendingHandoff(value: PendingHandoff | null): void;
}

export interface HubStatePorts extends HubStateContext {}

export function createHubStateContext(ports: HubStatePorts): HubStateContext {
	return {
		getCurrentContext: ports.getCurrentContext,
		setCurrentContext: ports.setCurrentContext,
		getExemptionsFile: ports.getExemptionsFile,
		setExemptionsFile: ports.setExemptionsFile,
		getSessionDir: ports.getSessionDir,
		setSessionDir: ports.setSessionDir,
		getWidgetContext: ports.getWidgetContext,
		setWidgetContext: ports.setWidgetContext,
		getPendingHandoff: ports.getPendingHandoff,
		setPendingHandoff: ports.setPendingHandoff,
	};
}
