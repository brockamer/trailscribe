import { parseCommand } from '../src/agent/grammar';

describe('parseCommand', () => {
  test('parses ping command', () => {
    const cmd = parseCommand('!ping');
    expect(cmd).toEqual({ type: 'ping' });
  });

  test('parses todo command', () => {
    const cmd = parseCommand('!todo Buy milk');
    expect(cmd).toEqual({ type: 'todo', task: 'Buy milk' });
  });

  test('parses mail command', () => {
    const cmd = parseCommand('!mail to:test@example.com subj:Hello body:Hi there');
    expect(cmd).toEqual({ type: 'mail', to: 'test@example.com', subj: 'Hello', body: 'Hi there' });
  });

  test('returns undefined for unknown command', () => {
    const cmd = parseCommand('hello world');
    expect(cmd).toBeUndefined();
  });
});