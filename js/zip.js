// Just enough of a zip reader to open a brand pack: list the files, and
// unpack one when it's picked (the browser's own deflate does the work).

export function listZip(buf) {
  const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That zip file is damaged.');
  let count = v.getUint16(eocd + 10, true), p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('That zip file is too big to open here.');
  const out = [], dec = new TextDecoder();
  while (count-- > 0 && v.getUint32(p, true) === 0x02014b50) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true), name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;   // folders and Mac metadata
    out.push({ name, method, size, usize, local });
  }
  return out;
}

export async function unzipEntry(buf, e) {
  const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const data = b.subarray(start, start + e.size);
  if (e.method === 0) return data.slice();
  if (e.method !== 8) throw new Error('That file in the zip uses a compression the browser can\'t open.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
