/**
 * Minimal WebAssembly binary walker: just enough to locate custom sections.
 * This is deliberately not a wasm parser — we never validate or execute code,
 * we only need the `contractspecv0` custom section payload. XDR decoding of
 * that payload is delegated to the SDK (we do not reimplement XDR).
 */

const WASM_MAGIC = 0x6d736100; // "\0asm" little-endian

class ByteCursor {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error("wasm: unexpected end of file");
    return this.buf[this.pos++]!;
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("wasm: unexpected end of file");
    const v =
      this.buf[this.pos]! |
      (this.buf[this.pos + 1]! << 8) |
      (this.buf[this.pos + 2]! << 16) |
      (this.buf[this.pos + 3]! << 24);
    this.pos += 4;
    return v >>> 0;
  }

  leb128u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error("wasm: LEB128 value too large");
    }
    return result >>> 0;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("wasm: unexpected end of file");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export interface CustomSection {
  name: string;
  payload: Uint8Array;
}

/** Walk all sections and return every custom (id 0) section. */
export function customSections(wasm: Uint8Array): CustomSection[] {
  const c = new ByteCursor(wasm);
  if (c.u32() !== WASM_MAGIC) throw new Error("not a wasm module (bad magic)");
  const version = c.u32();
  if (version !== 1) throw new Error(`unsupported wasm version ${version}`);

  const sections: CustomSection[] = [];
  while (!c.eof) {
    const id = c.u8();
    const size = c.leb128u32();
    const body = c.bytes(size);
    if (id === 0) {
      const bc = new ByteCursor(body);
      const nameLen = bc.leb128u32();
      const name = new TextDecoder().decode(bc.bytes(nameLen));
      sections.push({ name, payload: body.subarray(bc.pos) });
    }
  }
  return sections;
}

/** The Soroban contract spec custom section, or null when absent. */
export function contractSpecSection(wasm: Uint8Array): Uint8Array | null {
  for (const s of customSections(wasm)) {
    if (s.name === "contractspecv0") return s.payload;
  }
  return null;
}
