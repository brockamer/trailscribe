import { isDuplicate, markProcessed } from '../src/runtime/idempotency';

describe('idempotency', () => {
  test('marks and detects duplicates', () => {
    const id = 'abc123';
    expect(isDuplicate(id)).toBe(false);
    markProcessed(id);
    expect(isDuplicate(id)).toBe(true);
  });
});