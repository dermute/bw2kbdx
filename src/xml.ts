/** A deliberately small XML 1.0 serializer/reader for KeePass exchange XML.
 * No DTDs, external entities, namespaces, or processing instructions are accepted.
 * This module handles interchange only; KeePassXC owns KDBX and cryptography.
 */
export interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  text: string;
}

function validText(value: string): string {
  if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
    throw new Error('Vault contains text not representable in XML 1.0; backup unchanged');
  }
  return value;
}

export function element(name: string, text = '', children: Element[] = [], attrs: Record<string, string> = {}): Element {
  return { name, text: validText(text), children, attrs };
}

function escape(value: string): string {
  return validText(value).replace(/[&<>"'\r]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;',
  })[char]!);
}

export function serialize(node: Element): string {
  const name = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  if (!name.test(node.name) || Object.keys(node.attrs).some(key => !name.test(key))) throw new Error('Invalid XML name');
  const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
  return `<${node.name}${attrs}>${escape(node.text)}${node.children.map(serialize).join('')}</${node.name}>`;
}

function unescape(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) throw new Error('Invalid XML entity');
  return validText(value.replace(/&([^;]+);/g, (_, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (code in named) return named[code]!;
    const point = code.startsWith('#x') ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    if (!Number.isInteger(point) || point > 0x10ffff) throw new Error('Invalid XML character');
    return String.fromCodePoint(point);
  }));
}

export function parseXml(input: string, preserveRawCarriageReturns = false): Element {
  const withoutBom = input.replace(/^\ufeff/, '');
  const xml = preserveRawCarriageReturns ? withoutBom : withoutBom.replace(/\r\n?/g, '\n');
  const stack: Element[] = [];
  let root: Element | undefined;
  let position = 0;
  while (position < xml.length) {
    if (xml.startsWith('<?xml ', position) && position === 0) {
      const end = xml.indexOf('?>', position);
      if (end < 0) throw new Error('Invalid XML declaration');
      position = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', position)) {
      const end = xml.indexOf('-->', position + 4);
      if (end < 0) throw new Error('Invalid XML comment');
      position = end + 3;
      continue;
    }
    if (xml[position] !== '<') {
      const end = xml.indexOf('<', position);
      const text = unescape(xml.slice(position, end < 0 ? xml.length : end));
      if (stack.length) stack.at(-1)!.text += text;
      else if (text.trim()) throw new Error('Text outside XML root');
      position = end < 0 ? xml.length : end;
      continue;
    }
    const end = xml.indexOf('>', position);
    if (end < 0) throw new Error('Unclosed XML tag');
    const tag = xml.slice(position + 1, end);
    position = end + 1;
    if (tag.startsWith('/')) {
      if (stack.pop()?.name !== tag.slice(1).trim()) throw new Error('Mismatched XML tag');
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)([\s\S]*?)(\/?)$/.exec(tag);
    if (!match) throw new Error('Unsupported XML markup');
    const node = element(match[1]!);
    let rest = match[2]!;
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!attr || Object.hasOwn(node.attrs, attr[1]!)) throw new Error('Invalid XML attribute');
      node.attrs[attr[1]!] = unescape(attr[2] ?? attr[3]!);
      rest = rest.slice(attr[0].length);
    }
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) throw new Error('Multiple XML roots');
    else root = node;
    if (!match[3]) stack.push(node);
    if (stack.length > 128) throw new Error('XML nesting exceeds limit');
  }
  if (!root || stack.length) throw new Error('Incomplete XML document');
  return root;
}

export const children = (node: Element, name: string): Element[] => node.children.filter(child => child.name === name);
export function child(node: Element, name: string): Element {
  const matches = children(node, name);
  if (matches.length !== 1) throw new Error(`Expected one XML ${name} element`);
  return matches[0]!;
}
