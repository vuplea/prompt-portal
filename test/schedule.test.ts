import { describe, expect, test } from 'bun:test';

import { InputScheduler, MAX_SCHEDULES, MAX_SCHEDULE_DELAY_MS } from '../cli/schedule';
import { MAX_FIELD_CHARS } from '../lib/protocol';

// Fast clocks: tick every few ms, keystrokes shortly apart, so firing is
// observable without real waits. The defaults keep the production invariant
// that a fire sequence (up to 2 x keyDelayMs) fits inside one tick.
function makeScheduler(tickMs = 15, keyDelayMs = 5) {
  const writes: string[] = [];
  let changes = 0;
  const scheduler = new InputScheduler((d) => writes.push(d), () => { changes += 1; }, tickMs, keyDelayMs);
  return { scheduler, writes, changes: () => changes };
}

describe('add', () => {
  test('validates text, delay, and the pending cap', () => {
    const { scheduler, changes } = makeScheduler();
    expect(scheduler.add('go', 60_000)).toBe(true);
    expect(scheduler.add('', 60_000)).toBe(false);
    expect(scheduler.add(5 as any, 60_000)).toBe(false);
    expect(scheduler.add('x'.repeat(MAX_FIELD_CHARS + 1), 60_000)).toBe(false);
    expect(scheduler.add('go', 0)).toBe(false);
    expect(scheduler.add('go', -5)).toBe(false);
    expect(scheduler.add('go', NaN)).toBe(false);
    expect(scheduler.add('go', '60000' as any)).toBe(false);
    expect(scheduler.add('go', MAX_SCHEDULE_DELAY_MS + 1)).toBe(false);
    expect(scheduler.list()).toHaveLength(1);
    expect(changes()).toBe(1); // rejected adds mutate nothing
    for (let i = 1; i < MAX_SCHEDULES; i++) expect(scheduler.add(`s${i}`, 60_000)).toBe(true);
    expect(scheduler.add('past the cap', 60_000)).toBe(false);
    expect(scheduler.list()).toHaveLength(MAX_SCHEDULES);
  });

  test('lists soonest first', () => {
    const { scheduler } = makeScheduler();
    scheduler.add('later', 120_000);
    scheduler.add('sooner', 60_000);
    expect(scheduler.list().map((s) => s.d)).toEqual(['sooner', 'later']);
  });

  test('records the Esc-first flag only for esc === true', () => {
    const { scheduler } = makeScheduler();
    scheduler.add('with', 60_000, true);
    scheduler.add('without', 60_000, 'yes');
    expect(scheduler.list().map((s) => s.esc)).toEqual([true, undefined]);
  });
});

describe('remove', () => {
  test('cancels a pending schedule; unknown ids are no-ops', () => {
    const { scheduler, changes } = makeScheduler();
    scheduler.add('go', 60_000);
    scheduler.remove('nope');
    scheduler.remove(5 as any);
    expect(scheduler.list()).toHaveLength(1);
    expect(changes()).toBe(1);
    scheduler.remove(scheduler.list()[0]!.id);
    expect(scheduler.list()).toEqual([]);
    expect(changes()).toBe(2);
  });
});

describe('firing', () => {
  test('types the text, then Enter as a separate write', async () => {
    const { scheduler, writes, changes } = makeScheduler();
    scheduler.add('go', 1);
    await Bun.sleep(100);
    expect(writes).toEqual(['go', '\r']);
    expect(scheduler.list()).toEqual([]);
    expect(changes()).toBe(2); // the add, then the fire
    // Draining the list stops the ticker; a later add must re-arm it.
    scheduler.add('again', 1);
    await Bun.sleep(100);
    expect(writes).toEqual(['go', '\r', 'again', '\r']);
  });

  test('an Esc-first schedule presses Esc, then the text, then Enter', async () => {
    const { scheduler, writes } = makeScheduler();
    scheduler.add('go', 1, true);
    await Bun.sleep(100);
    expect(writes).toEqual(['\x1b', 'go', '\r']);
  });

  test('schedules due together fire one per tick, never interleaved', async () => {
    const { scheduler, writes } = makeScheduler(20, 5);
    scheduler.add('a', 1);
    scheduler.add('b', 2);
    await Bun.sleep(150);
    expect(writes).toEqual(['a', '\r', 'b', '\r']);
  });
});
