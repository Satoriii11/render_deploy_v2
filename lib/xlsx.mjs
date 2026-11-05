import {inflateRawSync} from "node:zlib";
import {posix} from "node:path";

const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Excel 文件不是有效的 ZIP/XLSX 文件。");
}

function zipDirectory(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Excel 文件目录结构异常。");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, {method, compressedSize, uncompressedSize, localOffset});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error("Excel 工作表内容超过读取上限。");
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error("Excel 文件数据块异常。");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let output;
  if (entry.method === 0) output = Buffer.from(compressed);
  else if (entry.method === 8) output = inflateRawSync(compressed, {maxOutputLength: MAX_ENTRY_BYTES});
  else throw new Error("Excel 文件使用了不支持的压缩方式。");
  if (output.length !== entry.uncompressedSize) throw new Error("Excel 文件解压后的长度不匹配。");
  return output.toString("utf8");
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) result[match[1]] = decodeXml(match[3]);
  return result;
}

function textNodes(xml) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]));
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(match => textNodes(match[1]).join(""));
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^([A-Z]+)/i)?.[1]?.toUpperCase();
  if (!letters) return -1;
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function cellValue(attrs, body, strings) {
  const type = attrs.t || "";
  if (type === "inlineStr") return textNodes(body).join("");
  const raw = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
  if (raw == null || raw === "") return null;
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) ? (strings[index] ?? "") : "";
  }
  if (type === "b") return raw === "1";
  if (type === "str" || type === "e") return decodeXml(raw);
  const number = Number(raw);
  return Number.isFinite(number) ? number : decodeXml(raw);
}

function worksheetRows(xml, strings) {
  const matrix = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    const body = rowMatch[1];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const cellMatch of body.matchAll(cellPattern)) {
      const attrs = attributes(cellMatch[1]);
      const index = columnIndex(attrs.r);
      if (index < 0) continue;
      row[index] = cellValue(attrs, cellMatch[2] || "", strings);
    }
    matrix.push(row);
  }
  return matrix;
}

export function parseXlsxSheet(input, sheetName) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = zipDirectory(buffer);
  const workbook = readZipEntry(buffer, entries, "xl/workbook.xml");
  const relationships = readZipEntry(buffer, entries, "xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw new Error("Excel 文件缺少工作簿元数据。");

  const relMap = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.Id && attrs.Target) relMap.set(attrs.Id, attrs.Target);
  }

  let target = "";
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.name === sheetName) {
      target = relMap.get(attrs["r:id"] || attrs.id) || "";
      break;
    }
  }
  if (!target) throw new Error("Excel 中不存在工作表：" + sheetName);
  const sheetPath = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("xl", target));
  const sheetXml = readZipEntry(buffer, entries, sheetPath);
  if (!sheetXml) throw new Error("无法读取工作表：" + sheetName);
  const strings = sharedStrings(readZipEntry(buffer, entries, "xl/sharedStrings.xml"));
  const matrix = worksheetRows(sheetXml, strings).filter(row => row.some(value => value !== null && value !== undefined && value !== ""));
  if (matrix.length < 2) return [];

  const headers = matrix[0].map(value => value == null ? "" : String(value).trim());
  const records = [];
  for (const row of matrix.slice(1)) {
    const record = {};
    for (let index = 0; index < headers.length; index++) {
      const key = headers[index];
      if (key) record[key] = row[index] ?? null;
    }
    if (Object.values(record).some(value => value !== null && value !== "")) records.push(record);
  }
  return records;
}
