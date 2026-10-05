/**
 * Android binary XML (AXML) reader.
 *
 * resources inside an APK are not plain text: `AndroidManifest.xml` is compiled
 * into a chunked binary format. This module decodes just enough of it to recover
 * the values a store listing needs.
 *
 * Format reference: AOSP `frameworks/base/libs/androidfw/ResourceTypes.h`
 * (ResXMLTree_* structures).
 */

import { ByteReader } from "./zip.ts";

const CHUNK = {
  NULL: 0x0000,
  STRING_POOL: 0x0001,
  XML: 0x0003,
  XML_START_NAMESPACE: 0x0100,
  XML_END_NAMESPACE: 0x0101,
  XML_START_ELEMENT: 0x0102,
  XML_END_ELEMENT: 0x0103,
  XML_CDATA: 0x0104,
  XML_RESOURCE_MAP: 0x0180,
} as const;

/** android.util.TypedValue data types we care about. */
const TYPE = {
  NULL: 0x00,
  REFERENCE: 0x01,
  ATTRIBUTE: 0x02,
  STRING: 0x03,
  FLOAT: 0x04,
  DIMENSION: 0x05,
  FRACTION: 0x06,
  INT_DEC: 0x10,
  INT_HEX: 0x11,
  INT_BOOLEAN: 0x12,
  INT_COLOR_ARGB8: 0x1c,
  INT_COLOR_RGB8: 0x1d,
  INT_COLOR_ARGB4: 0x1e,
  INT_COLOR_RGB4: 0x1f,
} as const;

const UTF8_FLAG = 1 << 8;
const NO_ENTRY = 0xffffffff;

export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

export interface AxmlAttribute {
  namespace: string | null;
  name: string;
  /** Raw string value (from the XML string pool), or null when absent. */
  rawValue: string | null;
  /** Resolved value. `@0x7f0e0001` style references are returned as `ref:<hex>`. */
  value: string | number | boolean | null;
  /** A reference to another resource when `type` is `reference`. */
  reference?: number;
  type: string;
}

export interface AxmlElement {
  name: string;
  namespace: string | null;
  attributes: AxmlAttribute[];
  children: AxmlElement[];
}

/** Decodes a ResStringPool chunk into an array of strings. */
export function readStringPool(reader: ByteReader, chunkStart: number, chunkSize: number): string[] {
  reader.seek(chunkStart + 8); // skip type + headerSize
  const stringCount = reader.u32();
  reader.skip(4); // styleCount
  const flags = reader.u32();
  const stringsStart = reader.u32();
  reader.skip(4); // stylesStart

  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  const offsets: number[] = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) offsets[i] = reader.u32();

  const stringsStartAbs = chunkStart + stringsStart;
  const poolEnd = chunkStart + chunkSize;
  const strings: string[] = new Array(stringCount);

  for (let i = 0; i < stringCount; i++) {
    reader.seek(stringsStartAbs + offsets[i]);
    try {
      strings[i] = isUtf8 ? readUtf8String(reader) : readUtf16String(reader);
    } catch {
      strings[i] = "";
    }
    if (reader.offset > poolEnd) reader.seek(poolEnd);
  }

  return strings;
}

/**
 * UTF-8 string pool entry: two length prefixes (character count, then byte
 * count), each length being 1 or 2 bytes depending on the high bit.
 */
function readUtf8String(reader: ByteReader): string {
  readUtf8Length(reader); // character count, unused
  const byteLength = readUtf8Length(reader);
  if (byteLength <= 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(reader.slice(byteLength));
}

function readUtf8Length(reader: ByteReader): number {
  const first = reader.u8();
  if ((first & 0x80) !== 0) {
    return ((first & 0x7f) << 8) | reader.u8();
  }
  return first;
}

/** UTF-16 string pool entry: character count (1 or 2 u16s) then UTF-16LE data. */
function readUtf16String(reader: ByteReader): string {
  let charCount = reader.u16();
  if ((charCount & 0x8000) !== 0) {
    charCount = ((charCount & 0x7fff) << 16) | reader.u16();
  }
  if (charCount <= 0) return "";
  const bytes = reader.slice(charCount * 2);
  let out = "";
  for (let i = 0; i < charCount; i++) {
    out += String.fromCharCode(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
  }
  return out;
}

/** Reads a Res_value (8 bytes) and converts it to a JS value. */
function readResValue(reader: ByteReader, strings: string[]): Pick<AxmlAttribute, "value" | "type" | "reference"> {
  reader.skip(2); // size (always 8; some malformed APKs lie, so we ignore it)
  reader.skip(1); // res0
  const dataType = reader.u8();
  const data = reader.u32();

  switch (dataType) {
    case TYPE.STRING: {
      const index = data === NO_ENTRY ? -1 : data;
      return { value: index >= 0 ? (strings[index] ?? "") : "", type: "string" };
    }
    case TYPE.REFERENCE:
      return { value: `ref:${data.toString(16)}`, type: "reference", reference: data };
    case TYPE.INT_BOOLEAN:
      return { value: data !== 0, type: "boolean" };
    case TYPE.INT_DEC:
      return { value: data | 0, type: "int" };
    case TYPE.INT_HEX:
      return { value: `0x${data.toString(16)}`, type: "hex" };
    case TYPE.NULL:
      return { value: null, type: "null" };
    default:
      return { value: data, type: `0x${dataType.toString(16)}` };
  }
}

/**
 * Parses a compiled `AndroidManifest.xml` into an element tree.
 *
 * The parser is deliberately forgiving: a malformed manifest should degrade to
 * partial metadata rather than fail an upload, because the admin can always
 * correct the fields by hand.
 */
export function parseAxml(bytes: Uint8Array, debug = false): AxmlElement {
  const reader = new ByteReader(bytes);

  const rootType = reader.u16();
  const rootHeaderSize = reader.u16();
  reader.skip(4); // ResXMLTree_header.chunkSize spans the WHOLE document
  if (rootType !== CHUNK.XML) {
    throw new Error("不是有效的二进制 AndroidManifest.xml（缺少 XML 根块）。");
  }
  // Crucially, the root header's chunkSize covers every following chunk (per
  // AOSP ResXMLTree_header). Advancing by it would skip the entire document, so
  // we step past just the header and let the loop read the child chunks.
  reader.seek(rootHeaderSize || 8);

  let strings: string[] = [];
  const resourceMap: number[] = [];
  let root: AxmlElement | null = null;
  const stack: AxmlElement[] = [];

  while (reader.remaining >= 8) {
    const chunkStart = reader.offset;
    const chunkType = reader.u16();
    const headerSize = reader.u16();
    const chunkSize = reader.u32();

    if (chunkSize < 8 || chunkStart + chunkSize > bytes.length) {
      // Truncated or bogus trailing chunk: stop with whatever we already parsed.
      if (debug) console.log(`  [axml] BREAK at ${chunkStart} type=0x${chunkType.toString(16)} size=${chunkSize} len=${bytes.length}`);
      break;
    }
    if (debug) console.log(`  [axml] chunk @${chunkStart} type=0x${chunkType.toString(16)} headerSize=${headerSize} size=${chunkSize}`);

    switch (chunkType) {
      case CHUNK.STRING_POOL:
        strings = readStringPool(reader, chunkStart, chunkSize);
        break;

      case CHUNK.XML_RESOURCE_MAP: {
        const count = Math.floor((chunkSize - headerSize) / 4);
        reader.seek(chunkStart + headerSize);
        for (let i = 0; i < count; i++) resourceMap.push(reader.u32());
        break;
      }

      case CHUNK.XML_START_ELEMENT: {
        // Layout: ResChunk_header(8: type,headerSize,size) + line(4) + comment(4)
        // + ns(4) + name(4). So ns starts at +16 and name at +20.
        reader.seek(chunkStart + 16);
        const nsIndex = reader.i32();
        const nameIndex = reader.i32();
        reader.skip(2); // attributeStart
        reader.skip(2); // attributeSize
        const attributeCount = reader.u16();
        reader.skip(6); // idIndex, classIndex, styleIndex

        const element: AxmlElement = {
          name: nameIndex >= 0 ? (strings[nameIndex] ?? "") : "",
          namespace: nsIndex >= 0 ? (strings[nsIndex] ?? null) : null,
          attributes: [],
          children: [],
        };

        for (let i = 0; i < attributeCount; i++) {
          const attrNs = reader.i32();
          const attrName = reader.i32();
          const attrRawValue = reader.i32();
          const resolved = readResValue(reader, strings);

          // The raw string pool entry wins when present: for `android:versionName`
          // the typed value is already a string, but some tools only fill the raw
          // index, so prefer whichever is non-empty.
          const rawValue = attrRawValue >= 0 ? (strings[attrRawValue] ?? null) : null;
          const name = attrName >= 0 ? (strings[attrName] ?? "") : "";

          element.attributes.push({
            namespace: attrNs >= 0 ? (strings[attrNs] ?? null) : null,
            name,
            rawValue,
            value: rawValue !== null && rawValue !== "" ? rawValue : resolved.value,
            type: resolved.type,
            reference: resolved.reference,
          });
        }

        if (stack.length > 0) {
          stack[stack.length - 1].children.push(element);
        } else if (!root) {
          root = element;
        }
        stack.push(element);
        break;
      }

      case CHUNK.XML_END_ELEMENT:
        // Header is line(4) + comment(4) + ns(4) + name(4) = 16 bytes. The cursor
        // is repositioned to the chunk end by the loop below, so it must not be
        // advanced here or every closing tag would over-run by 8 bytes.
        stack.pop();
        break;

      // Namespace and CDATA chunks carry nothing we need.
      case CHUNK.XML_START_NAMESPACE:
      case CHUNK.XML_END_NAMESPACE:
      case CHUNK.XML_CDATA:
      case CHUNK.NULL:
      default:
        break;
    }

    reader.seek(chunkStart + chunkSize);
  }

  if (!root) {
    throw new Error("AndroidManifest.xml 中找不到任何元素。");
  }
  return root;
}

/** Depth-first search for the first element with the given name. */
export function findElement(node: AxmlElement, name: string): AxmlElement | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}

/** Returns all elements with the given name, depth-first. */
export function findElements(node: AxmlElement, name: string, out: AxmlElement[] = []): AxmlElement[] {
  if (node.name === name) out.push(node);
  for (const child of node.children) findElements(child, name, out);
  return out;
}

/** Looks up an attribute by local name, ignoring its namespace. */
export function getAttribute(element: AxmlElement | null, name: string): AxmlAttribute | undefined {
  if (!element) return undefined;
  return element.attributes.find((attr) => attr.name === name);
}

/** Convenience accessor returning the attribute value as a string. */
export function getAttributeString(element: AxmlElement | null, name: string): string | null {
  const attr = getAttribute(element, name);
  if (!attr || attr.value === null || attr.value === undefined) return null;
  return String(attr.value);
}

/**
 * Reads the numeric resource id of an attribute.
 *
 * Manifest attributes such as `android:label` are stored as references
 * (`ref:7f0e0001`) when they point at a resource table entry. We resolve it via
 * the resource map when available, otherwise fall back to the inline hex.
 */
export function getAttributeResourceId(
  element: AxmlElement | null,
  name: string,
  resourceMap: number[] = [],
): number | null {
  const attr = getAttribute(element, name);
  if (!attr) return null;

  if (typeof attr.reference === "number") return attr.reference >>> 0;

  // Some compilers emit the reference in the raw string slot instead.
  const hex = attr.rawValue ?? (typeof attr.value === "string" ? attr.value : null);
  if (hex && /^@?0x[0-9a-f]+$/i.test(hex)) {
    return Number.parseInt(hex.replace(/^@?0x/i, ""), 16) >>> 0;
  }

  // Or the value is an index into the resource map chunk.
  const index = typeof attr.value === "number" ? attr.value : Number.NaN;
  if (!Number.isNaN(index) && index >= 0 && index < resourceMap.length) {
    return resourceMap[index] >>> 0;
  }

  return null;
}
