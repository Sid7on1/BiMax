import { StringDecoder } from 'node:string_decoder';

/** Bounded diagnostic tail; a noisy server cannot retain its lifetime stderr. */
export class McpStderrTail {
  static readonly MAX_BYTES = 64 * 1024;
  private tail = Buffer.alloc(0);
  private readonly decoder = new StringDecoder('utf8');

  append(data: Buffer): string {
    if (data.length >= McpStderrTail.MAX_BYTES) {
      this.tail = Buffer.from(data.subarray(-McpStderrTail.MAX_BYTES));
    } else {
      const keep = Math.min(this.tail.length, McpStderrTail.MAX_BYTES - data.length);
      this.tail = Buffer.concat([this.tail.subarray(this.tail.length - keep), data], keep + data.length);
    }
    return this.decoder.write(data);
  }

  get retainedBytes(): number {
    return this.tail.length;
  }

  text(): string {
    // The bounded tail can start halfway through a UTF-8 character; omit that prefix.
    let start = 0;
    while (start < this.tail.length && (this.tail[start] & 0xc0) === 0x80) start++;
    return this.tail.subarray(start).toString('utf8');
  }
}
