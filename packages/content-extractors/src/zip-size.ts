const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_ENTRY_SIG = 0x02014b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

function fail(message: string): never {
  throw new Error(`Invalid ZIP archive: ${message}`);
}

/**
 * Sums the uncompressed sizes of all entries declared in a ZIP archive's central directory,
 * without inflating anything. Supports ZIP64. Throws when the bytes are not a readable ZIP.
 *
 * The sizes are what the archive claims; a parser that inflates the data still has to check
 * them, which JSZip (used by mammoth and exceljs) does.
 */
export function zipUncompressedSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;

  // The end-of-central-directory record sits at the end, followed by a comment of up to 64 KiB.
  let eocd = -1;
  const stop = Math.max(0, len - EOCD_SIZE - MAX_COMMENT);
  for (let i = len - EOCD_SIZE; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("not a ZIP file (no end of central directory record)");

  // Where the central directory must end: right before the (ZIP64) end record.
  let cdEnd = eocd;
  let entries = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(view.getBigUint64(locator + 8, true));
      if (z64 + 56 > len || view.getUint32(z64, true) !== ZIP64_EOCD_SIG) {
        fail("bad ZIP64 end of central directory record");
      }
      cdEnd = z64;
      entries = Number(view.getBigUint64(z64 + 32, true));
      cdSize = Number(view.getBigUint64(z64 + 40, true));
      cdOffset = Number(view.getBigUint64(z64 + 48, true));
    }
  }

  // An archive with bytes prepended (a self-extracting stub, for example) keeps offsets relative
  // to the original start; JSZip accepts it, so find the directory from its end instead.
  if (cdOffset + 4 > len || (entries > 0 && view.getUint32(cdOffset, true) !== CD_ENTRY_SIG)) {
    const shifted = cdEnd - cdSize;
    if (shifted >= 0 && shifted + 4 <= len && view.getUint32(shifted, true) === CD_ENTRY_SIG) {
      cdOffset = shifted;
    }
  }
  if (cdOffset + cdSize > len) fail("central directory lies outside the file");

  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > len || view.getUint32(pos, true) !== CD_ENTRY_SIG) {
      fail("truncated or corrupt central directory");
    }
    const size32 = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    let size = size32;
    if (size32 === 0xffffffff) {
      size = readZip64Size(view, pos + 46 + nameLen, extraLen);
    }
    total += size;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

/** Reads the 64-bit uncompressed size from an entry's ZIP64 extended information extra field. */
function readZip64Size(view: DataView, start: number, length: number): number {
  const end = start + length;
  if (end > view.byteLength) fail("truncated or corrupt central directory");
  let p = start;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      // The uncompressed size is the first field when the 32-bit value is 0xFFFFFFFF.
      if (size < 8 || p + 12 > end) fail("bad ZIP64 extra field");
      return Number(view.getBigUint64(p + 4, true));
    }
    p += 4 + size;
  }
  fail("missing ZIP64 extra field");
}

/**
 * Throws when the uncompressed size declared by a ZIP archive exceeds `maxBytes`, so a small
 * "zip bomb" is refused before a parser inflates it.
 */
export function assertZipUncompressedSize(bytes: Uint8Array, maxBytes: number): void {
  const size = zipUncompressedSize(bytes);
  if (size > maxBytes) {
    throw new Error(
      `Archive uncompressed size ${size} bytes exceeds the limit of ${maxBytes} bytes`,
    );
  }
}
