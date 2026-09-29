/**
 * What each app has spent today, against its `budgetUsdDaily` (docs/GATEWAY.md §4).
 *
 * The day is the gateway machine's local day: totals start again at local midnight. With a file,
 * they survive a restart — launchd restarts a crashed gateway, and that must not hand every app a
 * fresh budget.
 *
 * Cost is known only after a call, so the check stops the NEXT call: an app can end the day over
 * its budget by whatever it had in flight when it crossed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SpendLedger {
  /** Today's spend for the app, in US dollars. */
  spent(app: string): number;
  add(app: string, usd: number): void;
  /** Whole seconds until the totals start again — a refused call's `Retry-After`. */
  secondsToReset(): number;
}

interface Saved {
  day: string;
  usd: Record<string, number>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function createSpendLedger(
  o: {
    /** Kept here across restarts. Absent: memory only. */
    file?: string;
    now?: () => Date;
    /** A file that cannot be read or written — the ledger carries on in memory. */
    warn?: (line: string) => void;
  } = {},
): SpendLedger {
  const now = o.now ?? (() => new Date());
  let day = localDay(now());
  let usd: Record<string, number> = {};

  if (o.file) {
    try {
      const saved = JSON.parse(readFileSync(o.file, 'utf8')) as Partial<Saved>;
      if (saved.day === day && saved.usd && typeof saved.usd === 'object')
        for (const [app, v] of Object.entries(saved.usd)) if (typeof v === 'number' && v > 0) usd[app] = v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        o.warn?.(
          `llm-providers spend file ${o.file} unreadable, today starts at $0: ${(e as Error).message}`,
        );
    }
  }

  const rollOver = () => {
    const today = localDay(now());
    if (today !== day) {
      day = today;
      usd = {};
    }
  };

  const save = () => {
    if (!o.file) return;
    try {
      mkdirSync(dirname(o.file), { recursive: true });
      // Written whole, then renamed over the old one: a crash mid-write never leaves half a file.
      const tmp = `${o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day, usd } satisfies Saved), { mode: 0o600 });
      renameSync(tmp, o.file);
    } catch (e) {
      o.warn?.(`llm-providers spend file ${o.file} not written: ${(e as Error).message}`);
    }
  };

  return {
    spent(app) {
      rollOver();
      return usd[app] ?? 0;
    },
    add(app, amount) {
      if (!(amount > 0)) return;
      rollOver();
      usd[app] = (usd[app] ?? 0) + amount;
      save();
    },
    secondsToReset() {
      const d = now();
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      return Math.max(1, Math.ceil((midnight.getTime() - d.getTime()) / 1000));
    },
  };
}
