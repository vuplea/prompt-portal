import { MAX_FIELD_CHARS, type ScheduledInput } from '../lib/protocol';

// Scheduled inputs: at a chosen wall-clock time, type text into the pty as if
// at the keyboard, then press Enter. Owned by the session host — the one
// process whose lifetime is exactly the session's — so schedules survive hub
// restarts and link drops, need no link at all to fire, and die with the
// session.

// Bounds on what one session will hold. The delay cap keeps a unit mix-up
// (ms where hours were meant, say) from parking a schedule in the
// unreachable future.
export const MAX_SCHEDULES = 20;
export const MAX_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Due schedules are found by polling the wall clock, not by setTimeout:
// timers count monotonic time, which stands still while the system sleeps —
// a schedule due at 06:00 would fire hours late on a machine that slept
// through the night. The poll compares Date.now() and catches up on wake.
const TICK_MS = 1000;

// The fire sequence is spaced keystrokes, not one write. Enter goes a beat
// after the text: TUIs with paste detection (claude among them) treat text
// and CR arriving together as one pasted blob — the CR becomes a newline in
// the input box instead of submitting it. A separate CR after a human-scale
// pause reads as a keystroke everywhere; tmux automation sends text and
// Enter as two send-keys calls for the same reason. The same spacing
// separates the optional leading Esc from the text.
const KEY_DELAY_MS = 300;

export class InputScheduler {
  private pending = new Map<string, ScheduledInput>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  // write receives each keystroke of the fire sequence; onChange fires after
  // every mutation — an add, a cancel, or a schedule firing.
  constructor(private write: (data: string) => void,
              private onChange: () => void,
              private tickMs = TICK_MS,
              private keyDelayMs = KEY_DELAY_MS) {}

  // Soonest first — the order both the tick and the UI want.
  list(): ScheduledInput[] {
    return [...this.pending.values()].sort((a, b) => a.at - b.at);
  }

  // Fields arrive from a frame untyped; a rejected add is the caller's to
  // answer. esc asks for a leading Esc keystroke — it dismisses a modal
  // dialog the target app may have parked over its composer (Claude Code's
  // usage-limit menu, whose focused default the trailing Enter would
  // otherwise blindly confirm). Per schedule, not always: in a plain
  // readline shell a lone Esc opens a meta- sequence that would eat the
  // first typed character.
  add(text: unknown, delayMs: unknown, esc?: unknown): boolean {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FIELD_CHARS) return false;
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)
      || delayMs <= 0 || delayMs > MAX_SCHEDULE_DELAY_MS) return false;
    if (this.pending.size >= MAX_SCHEDULES) return false;
    const sched: ScheduledInput = { id: crypto.randomUUID(), d: text, at: Date.now() + delayMs };
    if (esc === true) sched.esc = true;
    this.pending.set(sched.id, sched);
    // JSON.stringify: the text comes from the phone via the hub — control
    // characters must not reach the log raw.
    console.log(`scheduled input ${JSON.stringify(text)} in ${Math.round(delayMs / 1000)}s`);
    this.arm();
    this.onChange();
    return true;
  }

  remove(id: unknown): void {
    if (typeof id !== 'string') return;
    const sched = this.pending.get(id);
    if (!sched) return;
    this.pending.delete(id);
    console.log(`scheduled input ${JSON.stringify(sched.d)} canceled`);
    this.arm();
    this.onChange();
  }

  // One fire per tick, even with several schedules due: a second sequence
  // started between one's text and its Enter would garble both. The whole
  // sequence spans at most 2 x keyDelayMs — inside one tick — so the next
  // tick picks up the next due schedule with the previous one fully typed.
  private tick(): void {
    const due = this.list()[0];
    if (!due || due.at > Date.now()) return;
    this.pending.delete(due.id);
    console.log(`scheduled input firing: ${JSON.stringify(due.d)}${due.esc ? ' (Esc first)' : ''}`);
    const keys = due.esc ? ['\x1b', due.d, '\r'] : [due.d, '\r'];
    this.write(keys[0]!);
    for (let i = 1; i < keys.length; i++) {
      setTimeout(() => this.write(keys[i]!), i * this.keyDelayMs);
    }
    this.arm();
    this.onChange();
  }

  // The ticker runs only while something is pending; unref'd so it never
  // holds the process open on its own.
  private arm(): void {
    if (this.pending.size > 0 && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), this.tickMs);
      this.ticker.unref?.();
    } else if (this.pending.size === 0 && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
