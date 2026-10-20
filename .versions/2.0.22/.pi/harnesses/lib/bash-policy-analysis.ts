import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { damageControlPathMatches, type PathRuleCategory } from "./damage-control-shared.ts";

interface Token { text: string; operator?: boolean; }
interface ShellCommand { words: string[]; reads: string[]; writes: string[]; deletes: string[]; patternText: string; opaque: boolean; }
export interface BashPolicyAnalysis { commands: ShellCommand[]; patternText: string; }

/** Recognize static shell words and operators only. Expansion, compound grammar
 * and interpreter source fall back to the existing conservative text checks.
 * This is operand classification, not a shell or arbitrary-program sandbox.
 */
function tokens(text: string): Token[] | null {
 const out: Token[] = []; let word = "", quoted = false, quote = "";
 const push = () => { if (word || quoted) out.push({ text: word }); word = ""; quoted = false; };
 for (let i = 0; i < text.length; i++) {
  const char = text[i];
  if (quote) {
   if (char === quote) { quote = ""; continue; }
   if (quote === '"' && /[$`]/.test(char)) return null;
   if (quote === '"' && char === "\\" && /["\\$`\n]/.test(text[i + 1] ?? "")) { const next = text[++i]; if (next !== "\n") word += next; continue; }
   word += char; continue;
  }
  if (char === "'" || char === '"') { quote = char; quoted = true; continue; }
  if (char === "\\") { if (i + 1 >= text.length) return null; const next = text[++i]; if (next !== "\n") word += next; continue; }
  if (/[$`(){}]/.test(char)) return null;
  if (char === "#" && !word && !quoted) { while (i < text.length && text[i] !== "\n") i++; push(); out.push({ text: ";", operator: true }); continue; }
  if (/[ \t\r]/.test(char)) { push(); continue; }
  if (/[;\n|&<>]/.test(char)) {
   push(); let operator = char === "\n" ? ";" : char;
   if (["||", "&&", ">>", "<<", ">&", "<&", "<>", "&>"].includes(char + text[i + 1])) operator += text[++i];
   if (["&", "<<", "<>"].includes(operator)) return null;
   out.push({ text: operator, operator: true }); continue;
  }
  word += char;
  if (out.length > 4096) return null;
 }
 if (quote) return null; push(); return out;
}

/** Only cat/tee receive a quoted heredoc as literal data. Shell/interpreter
 * heredocs and unquoted (expanding) delimiters retain conservative handling.
 */
function unquotedAt(text: string, index: number): boolean {
 let quote = "";
 for (let i = 0; i < index; i++) {
  const char = text[i];
  if (char === "\\" && quote !== "'") { if (++i >= index) return false; continue; }
  if (quote) { if (char === quote) quote = ""; }
  else if (char === "'" || char === '"') quote = char;
 }
 return !quote;
}

function withoutLiteralHeredocs(text: string): string | null {
 const lines = text.split("\n"), retained: string[] = [];
 for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes("<<")) { retained.push(line); continue; }
  const match = /<<\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")/.exec(line);
  if (!match || !unquotedAt(line, match.index)
   || !/^(?:\s|[<>]|$)/.test(line.slice(match.index + match[0].length))
   || line.replace(match[0], "").includes("<<")) return null;
  const header = line.replace(match[0], ""), parsed = tokens(header);
  if (!parsed || !["cat", "tee"].includes(parsed[0]?.text) || parsed.some(t => t.operator && ![">", ">>", "<", ">&", "<&", "&>"].includes(t.text))) return null;
  const delimiter = match[1] ?? match[2]; let end = i + 1;
  while (end < lines.length && lines[end] !== delimiter) end++;
  if (end === lines.length) return null;
  retained.push(header); i = end;
 }
 return retained.join("\n");
}

/** Keep literal data out of fallback path/pattern checks even when another
 * command (e.g. sed) requires conservative analysis. Headers and destinations
 * remain visible; expanding/interpreter heredocs are never stripped. */
export function bashPolicyText(command: string): string {
 const stripped = withoutLiteralHeredocs(command);
 if (stripped === null || stripped === command) return command;
 // Only ordinary data/inspection commands may follow literal data. Unknown
 // programs, wrappers, assignments and repository executables might execute the
 // generated file; retain the body instead of trying to unwrap shell grammar.
 const parts = tokens(stripped);
 if (!parts) return command;
 const dataOnly = new Set(['cat', 'tee', 'ls', 'pwd', 'stat', 'head', 'tail', 'wc', 'grep', 'rg', 'test', 'readlink', 'realpath', 'du', 'printf', 'echo', 'sed']);
 let start = true;
 for (let i=0;i<parts.length;i++) {
  const part=parts[i];
  if (part.operator && [';', '&&', '||', '|'].includes(part.text)) { start = true; continue; }
  if (!part.operator && start) {
   if (!dataOnly.has(part.text)) return command;
   // sed can execute shell commands: only a plain numeric print is data-only.
   if (part.text==='sed') {
    if (!(parts[i+1]?.text==='-n' && /^\d+(?:,\d+)?p$/.test(parts[i+2]?.text??''))) return command;
    for(let j=i+3;j<parts.length&&!(parts[j].operator&&[';', '&&', '||', '|'].includes(parts[j].text));j++)if(!parts[j].operator&&parts[j].text.startsWith('-'))return command;
   }
   start = false;
  }
  if (!part.operator && /^--pre(?:=|$)/.test(part.text)) return command;
 }
 return stripped;
}

const readers = new Set(["cat", "ls", "pwd", "stat", "head", "tail", "wc", "file", "grep", "rg", "find", "test", "readlink", "realpath", "du"]);
const writers = new Set(["rm", "mv", "cp", "touch", "mkdir", "rmdir", "install", "chmod", "chown", "truncate", "tee"]);
const dataCommands = new Set(["printf", "echo"]);
// Preserve option text and operands after `--`. Long options may carry a path
// after `=`; ambiguous attached short options use conservative handling below.
// Bash tilde-expands assignment-like arguments after `=` and `:` (`dd if=~/.ssh/id_rsa`,
// `K=a:~/x`), so each value segment is an operand too.
const operands = (words: string[]) => words.flatMap(word => {
 if (word === "--") return [];
 if (word.startsWith("-") && word.includes("=")) return [word, word.slice(word.indexOf("=") + 1)];
 const assignment = /^[A-Za-z_]\w*=([^]*)$/.exec(word);
 return assignment ? [word, ...assignment[1].split(":").filter(Boolean)] : [word];
});

export function analyzeBashCommand(command: string): BashPolicyAnalysis | null {
 const literal = bashPolicyText(command);
 const parsed = tokens(literal); if (!parsed) return null;
 const commands: ShellCommand[] = []; let words: string[] = [], reads: string[] = [], writes: string[] = [], requiresDataSink = false;
 const finish = (): boolean => {
  if (!words.length) return !reads.length && !writes.length;
  const name = basename(words[0]), args = words.slice(1), paths = operands(args);
  // A repository executable named cat/printf/etc need not behave like a utility.
  if (words[0] !== name || ["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "eval", "exec", "source", ".", "cd", "pushd", "popd"].includes(name)
   || args.some(arg => /^(?:-exec|-execdir|-ok|-okdir|-delete|-fprint|-fprintf|-fls|--pre)(?:=|$)/.test(arg))
   || /^[A-Za-z_]\w*=/.test(words[0]) || ["bash", "sh", "zsh"].includes(name)
   || ["sed", "file"].includes(name)
   || name !== "find" && args.some(arg => /^-[^-].+/.test(arg))
   || ["node", "nodejs", "python", "python3", "perl", "ruby"].includes(name) && args.some(arg => /^-(?:.*[ec]|-eval)(?:=|$)/.test(arg))) return false;
  if(requiresDataSink&&!readers.has(name)&&!dataCommands.has(name)&&name!=="tee")return false;
  let modified: string[] = [];
  if (writers.has(name)) modified = paths;
  else if (!readers.has(name) && !dataCommands.has(name)) modified = paths;
  const referenced = dataCommands.has(name) ? [] : [words[0], ...paths];
  const patternText = readers.has(name) || dataCommands.has(name) ? words[0] : words.join(" ");
  const opaqueDeletion=!readers.has(name)&&!writers.has(name)&&!dataCommands.has(name)&&/\b(?:rm|mv|rmdir)\b/.test(words.join(" "));
  const opaque=!readers.has(name)&&!writers.has(name)&&!dataCommands.has(name)&&!opaqueDeletion;
  commands.push({ words, reads: [...reads, ...referenced], writes: [...writes, ...modified], deletes: ["rm", "mv", "rmdir"].includes(name)||opaqueDeletion ? paths : [], patternText, opaque });
  words = []; reads = []; writes = []; requiresDataSink=false;return true;
 };
 for (let i = 0; i < parsed.length; i++) {
  const token = parsed[i];
  if (!token.operator) { words.push(token.text); continue; }
  if ([";", "&&", "||", "|"].includes(token.text)) {
   // A continued pipe must never lose its pending consumer across a newline or
   // comment. Unsupported separator combinations retain conservative checks.
   if (requiresDataSink && !words.length || !finish()) return null;
   requiresDataSink=token.text==="|";continue;
  }
  if (!parsed[i + 1] || parsed[i + 1].operator) return null;
  if([">&","<&"].includes(token.text)) { if(!/^(?:\d+|-)$/.test(parsed[++i].text))return null;continue; }
  if (![">", ">>", "<", "&>"].includes(token.text)) return null;
  (token.text === "<" ? reads : writes).push(parsed[++i].text);
 }
 if (!finish()) return null;
 return { commands, patternText: commands.map(c => c.patternText).join("\n") };
}

function matches(target: string, pattern: string, cwd: string): boolean {
 const expanded = target.startsWith("~/") ? resolve(homedir(), target.slice(2)) : target;
 const absolute = resolve(cwd, expanded);
 if (pattern.endsWith("/")) {
  const base = pattern.startsWith("~/") ? resolve(homedir(), pattern.slice(2)) : pattern;
  if (isAbsolute(base)) return absolute === resolve(base) || absolute.startsWith(resolve(base) + "/");
  const relative = base.replace(/^\.\//, "").replace(/\/$/, "");
  return absolute.endsWith("/" + relative) || absolute.includes("/" + relative + "/");
 }
 if (damageControlPathMatches(absolute, pattern, cwd)) return true;
 // A literal shell glob can name a protected file even before expansion.
 return target.includes("*") && (damageControlPathMatches(resolve(cwd, pattern), target, cwd)
  || !pattern.includes("/") && damageControlPathMatches(resolve(dirname(absolute), pattern), target, cwd));
}

export function bashReferencesProtectedPath(analysis: BashPolicyAnalysis, category: PathRuleCategory, pattern: string, cwd: string): boolean {
 // A slash-free word of an unknown program (`npm run build`, `cargo build`) names a
 // subcommand far more often than a relative output directory; known writers stay exact.
 const relativeDirectory = pattern.endsWith("/") && !isAbsolute(pattern) && !pattern.startsWith("~");
 const subcommand = (command: ShellCommand, candidate: string) => category === "read_only" && relativeDirectory && command.opaque && !candidate.includes("/");
 return analysis.commands.some(command => {
  const candidates = category === "zero_access" ? [...command.reads, ...command.writes] : category === "read_only" ? command.writes : command.deletes;
  return candidates.some(candidate => !subcommand(command, candidate) && matches(candidate, pattern, cwd));
 });
}
