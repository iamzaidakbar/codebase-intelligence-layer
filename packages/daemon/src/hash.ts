import { createHash } from 'node:crypto';

export const hash = (input: string | Buffer): string =>
  createHash('sha1').update(input).digest('hex');
