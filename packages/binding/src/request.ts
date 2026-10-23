/**
 * A command's request id: a non-empty string of at most 128 characters. A host has nothing to answer a command
 * under without one, so it ignores the command; a caller checks its own ids before it sends.
 */
export const isRequestId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
