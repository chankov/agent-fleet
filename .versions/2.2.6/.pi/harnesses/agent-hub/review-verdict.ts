// Native reviewer markdown is presentation, not a weaker acceptance contract.
// A recognized REJECT always vetoes APPROVE; incidental prose/JSON is not a verdict.
export function affirmativeReviewVerdict(output:string):boolean {
 const verdicts=Array.from(output.matchAll(/(?:^|\n)[ \t]*(?:(?:Verdict[ \t]*:|\*\*Verdict:\*\*|\*\*Verdict\*\*:)[ \t]*)?(APPROVE|REJECT)\b/gi),m=>m[1].toUpperCase());
 for (const match of output.matchAll(/^[ \t]*\*\*Verdict[ \t]*:[ \t]*(APPROVE|REJECT)\.?\*\*[ \t]*\r?$/gim)) verdicts.push(match[1].toUpperCase());
 return verdicts.includes('APPROVE')&&!verdicts.includes('REJECT');
}
