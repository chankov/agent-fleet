import { posix } from "node:path";
import { marked } from "marked";

function markdownLinks(text) {
  const links = [];
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === "link" || token.type === "image") links.push(token.href);
    if (token.type === "html") {
      const html = token.raw.replace(/<!--[\s\S]*?-->/g, "");
      const attributes = /<(?:a|img)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      for (const [, doubleQuoted, singleQuoted, unquoted] of html.matchAll(attributes)) {
        links.push(doubleQuoted ?? singleQuoted ?? unquoted);
      }
    }
  });
  return links;
}

export function missingPackagedDocLinks(files, readMarkdown) {
  const targets = new Set([".", ...files]);
  for (const file of files) {
    for (let dir = posix.dirname(file); !targets.has(dir); dir = posix.dirname(dir)) targets.add(dir);
  }

  const failures = new Set();
  for (const file of files) {
    // Installer baselines and third-party package trees carry their own historical docs.
    if (!/\.md$/i.test(file) || file.startsWith(".versions/") || file.split("/").includes("node_modules")) continue;
    for (const link of markdownLinks(readMarkdown(file))) {
      const pathname = link.trim().split(/[?#]/, 1)[0];
      if (!pathname || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(pathname)) continue;
      try {
        const target = posix.join(posix.dirname(file), decodeURIComponent(pathname)).replace(/\/$/, "");
        if (!targets.has(target)) failures.add(`${file} → ${link} (${target})`);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        failures.add(`${file} → ${link} (invalid URL encoding)`);
      }
    }
  }
  return [...failures].sort();
}
