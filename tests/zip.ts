/** Fabrique une archive ZIP (deflate) en mémoire, pour tester la lecture des .mxl. */

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function makeZip(files: Record<string, string>, stored: string[] = []): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
  const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const [name, content] of Object.entries(files)) {
    const raw = encoder.encode(content);
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const nameBytes = [...encoder.encode(name)];
    const offset = local.length;
    const common = [...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(crc32(raw)), ...le32(data.length), ...le32(raw.length), ...le16(nameBytes.length)];
    local.push(...le32(0x04034b50), ...common, ...le16(0), ...nameBytes, ...data);
    central.push(...le32(0x02014b50), ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nameBytes);
  }
  const count = Object.keys(files).length;
  const end = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(count), ...le16(count), ...le32(central.length), ...le32(local.length), ...le16(0)];
  return new Uint8Array([...local, ...central, ...end]);
}
