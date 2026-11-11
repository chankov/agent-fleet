import { formatVersionLabel } from "./version.ts";

type FooterTheme = {
	fg(color: string, text: string): string;
};

export function composeHubFooterLeft(
	version: string | null,
	model: string,
	thinkingSuffix: string,
): string {
	return [version ? formatVersionLabel(version) : "", `${model}${thinkingSuffix}`]
		.filter(Boolean)
		.join(" · ");
}

export function composeFleetFooterHint(): string {
	return "Alt+A fleet · Alt+I inspect";
}

export function renderHubFooterLeft(
	theme: FooterTheme,
	version: string | null,
	model: string,
	thinkingSuffix: string,
): string {
	const metadata = composeHubFooterLeft(version, model, thinkingSuffix);
	return theme.fg("dim", ` ${metadata}`);
}
