// @ts-nocheck
/** JSON parser that refuses duplicate object keys, including escaped aliases. */
export function parseConfigJson(text) {
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('Invalid JSON string');
  };
  const value = path => {
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (i < text.length) {
        space(); if (text[i] !== '"') throw new Error(`Invalid JSON at ${path}`);
        const key = string();
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${path}.${key}`);
        keys.add(key); space(); if (text[i++] !== ':') throw new Error(`Invalid JSON at ${path}`);
        value(`${path}.${key}`); space();
        const end = text[i++]; if (end === '}') return; if (end !== ',') throw new Error(`Invalid JSON at ${path}`);
      }
    } else if (text[i] === '[') {
      i++; space(); if (text[i] === ']') { i++; return; }
      let index = 0;
      while (i < text.length) { value(`${path}[${index++}]`); space(); const end = text[i++]; if (end === ']') return; if (end !== ',') throw new Error(`Invalid JSON at ${path}`); }
    } else if (text[i] === '"') { string(); return; }
    else { const start = i; while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; JSON.parse(text.slice(start, i)); return; }
    throw new Error(`Invalid JSON at ${path}`);
  };
  value('$'); space(); if (i !== text.length) throw new Error('Invalid trailing JSON');
  return JSON.parse(text);
}
