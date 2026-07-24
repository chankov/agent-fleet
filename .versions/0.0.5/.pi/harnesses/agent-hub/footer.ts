type FooterTheme = {
	fg(color: string, text: string): string;
};

export function composeHubFooterLeft(
	version: string | null,
	model: string,
	thinkingSuffix: string,
	team: string,
): string {
	return [version ? `v${version}` : "", `${model}${thinkingSuffix}`, team]
		.filter(Boolean)
		.join(" · ");
}

export function renderHubFooterLeft(
	theme: FooterTheme,
	version: string | null,
	model: string,
	thinkingSuffix: string,
	team: string,
): string {
	const metadata = [version ? `v${version}` : "", `${model}${thinkingSuffix}`]
		.filter(Boolean)
		.join(" · ");
	const dimMetadata = theme.fg("dim", ` ${metadata}`);
	const separator = metadata && team ? theme.fg("muted", " · ") : "";
	return dimMetadata + separator + (team ? theme.fg("accent", team) : "");
}
