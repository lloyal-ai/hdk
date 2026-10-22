/**
 * A command's request id: what a host answers under. One rule for every command
 * that carries one, so a caller can check its own ids before it sends.
 */
import { describe, it, expect } from 'vitest';
import { isRequestId } from '../src/index';

describe('isRequestId', () => {
  it('takes a non-empty string of at most 128 characters, and nothing else', () => {
    expect(['a', 'x'.repeat(128), 'cats-and-dogs'].every(isRequestId)).toBe(true);
    expect(['', 'x'.repeat(129), 7, undefined, null, {}].some(isRequestId)).toBe(false);
  });
});
