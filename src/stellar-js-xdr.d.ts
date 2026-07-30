declare module "@stellar/js-xdr" {
  export class XdrReader {
    constructor(source: Buffer | Uint8Array);
    readonly eof: boolean;
  }
  const jsxdr: { XdrReader: typeof XdrReader };
  export default jsxdr;
}
