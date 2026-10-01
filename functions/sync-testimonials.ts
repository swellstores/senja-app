import { listTestimonials, SenjaApiError } from './lib/senja';
import { recordSyncStatus, statusMessages } from './lib/sync-status';
import { removeMissingTestimonials, syncTestimonialBatch, type SyncCounts } from './lib/testimonials';

export const config: SwellConfig = {
  description: 'Copy testimonials from Senja: a quick check every 10 minutes and a full sync once a day',
  cron: {
    schedule: '*/10 * * * *',
  },
  timeout: 10000,
};

export const PAGE_SIZE = 25;
/** Stop starting new work after this long, leaving headroom under the 10s function limit. */
export const TIME_BUDGET_MS = 6000;
/** How often a full sync runs, to pick up edits to older testimonials and deletions. */
export const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed run (e.g. a wrong API key), try again sooner so a fixed key takes effect. */
export const RETRY_FAILED_MS = 60 * 60 * 1000;
/** The quick check reads at most this many pages of the newest testimonials. */
export const QUICK_CHECK_MAX_PAGES = 4;

interface SyncRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  phase?: 'fetch' | 'cleanup';
  next_page: number;
  created: number;
  updated: number;
  unchanged: number;
  removed?: number;
  seen_ids?: string[];
  cleanup_after?: string | null;
  date_started?: string;
  date_completed?: string;
}

async function latestRun(swell: SwellAPI): Promise<SyncRun | null> {
  const result = (await swell.get('/syncs', { sort: 'date_created desc', limit: 1 })) as {
    results?: SyncRun[];
  } | null;
  return result?.results?.[0] ?? null;
}

/** Returns the full-sync run to work on now, or null when none is due. */
export async function runToContinue(swell: SwellAPI, now: number): Promise<SyncRun | null> {
  const latest = await latestRun(swell);
  if (latest?.status === 'running') {
    return latest;
  }
  const lastFinished = latest?.date_completed ?? latest?.date_started;
  const interval = latest?.status === 'failed' ? RETRY_FAILED_MS : RESYNC_INTERVAL_MS;
  if (latest && lastFinished && now - new Date(lastFinished).getTime() < interval) {
    return null;
  }
  return (await swell.post('/syncs', {
    status: 'running',
    phase: 'fetch',
    next_page: 1,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    seen_ids: [],
    date_started: new Date(now).toISOString(),
  })) as SyncRun;
}

/**
 * Between full syncs: read the newest testimonials and copy new or changed ones.
 * Keeps reading while a whole page was new, since there may be more new ones behind it.
 */
export async function quickCheck(swell: SwellAPI, apiKey: string, startedAt: number) {
  const totals: SyncCounts = { created: 0, updated: 0, unchanged: 0 };
  for (let page = 1; page <= QUICK_CHECK_MAX_PAGES && Date.now() - startedAt < TIME_BUDGET_MS; page++) {
    const { testimonials, hasMore } = await listTestimonials(apiKey, { page, limit: PAGE_SIZE });
    const counts = await syncTestimonialBatch(swell, testimonials);
    totals.created += counts.created;
    totals.updated += counts.updated;
    totals.unchanged += counts.unchanged;
    if (!hasMore || counts.created < testimonials.length) {
      break;
    }
  }
  return totals;
}

async function continueFullSync(swell: SwellAPI, apiKey: string, run: SyncRun, startedAt: number) {
  const progress = {
    phase: run.phase ?? 'fetch',
    next_page: run.next_page || 1,
    created: run.created || 0,
    updated: run.updated || 0,
    unchanged: run.unchanged || 0,
    removed: run.removed || 0,
    seen_ids: run.seen_ids ?? [],
    cleanup_after: run.cleanup_after ?? null,
  };

  try {
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      if (progress.phase === 'fetch') {
        const { testimonials, hasMore } = await listTestimonials(apiKey, { page: progress.next_page, limit: PAGE_SIZE });
        const counts = await syncTestimonialBatch(swell, testimonials);
        progress.created += counts.created;
        progress.updated += counts.updated;
        progress.unchanged += counts.unchanged;
        progress.seen_ids.push(...testimonials.map((t) => t.id));
        if (hasMore) {
          progress.next_page++;
        } else {
          progress.phase = 'cleanup';
          progress.cleanup_after = null;
        }
        continue;
      }

      // Never remove anything if Senja returned no testimonials at all: more likely an API problem than an empty account.
      const { removed, next_after } = progress.seen_ids.length
        ? await removeMissingTestimonials(swell, new Set(progress.seen_ids), progress.cleanup_after)
        : { removed: 0, next_after: null };
      progress.removed += removed;
      progress.cleanup_after = next_after;

      if (!next_after) {
        const completed = {
          ...progress,
          status: 'completed' as const,
          seen_ids: [],
          date_completed: new Date(Date.now()).toISOString(),
          error: null,
        };
        await swell.put(`/syncs/${run.id}`, completed);
        const { seen_ids, cleanup_after, ...summary } = completed;
        return { id: run.id, ...summary };
      }
    }

    await swell.put(`/syncs/${run.id}`, progress);
    const { seen_ids, cleanup_after, ...summary } = progress;
    return { id: run.id, status: 'running', ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An auth problem won't fix itself on the next run; other errors (rate limits, outages) are retried.
    const fatal = error instanceof SenjaApiError && (error.status === 401 || error.status === 403);
    await swell.put(`/syncs/${run.id}`, {
      ...progress,
      status: fatal ? 'failed' : 'running',
      error: message,
      ...(fatal ? { seen_ids: [], date_completed: new Date(Date.now()).toISOString() } : {}),
    });
    return { id: run.id, status: fatal ? 'failed' : 'running', error: message };
  }
}

export default async function (req: SwellRequest) {
  const { swell, appId } = req;
  const settings = await swell.settings();
  const apiKey: string | undefined = settings?.connection?.api_key?.trim();
  if (!apiKey) {
    await recordSyncStatus(swell, appId, statusMessages.notConnected);
    return { skipped: 'no_api_key' };
  }

  const startedAt = Date.now();
  const run = await runToContinue(swell, startedAt);
  if (run) {
    const result = await continueFullSync(swell, apiKey, run, startedAt);
    await recordSyncStatus(swell, appId, fullSyncStatus(result));
    return result;
  }

  try {
    const counts = await quickCheck(swell, apiKey, startedAt);
    await recordSyncStatus(swell, appId, statusMessages.quickCheck(counts.created, counts.updated));
    return { quick_check: counts };
  } catch (error) {
    // The next full sync records errors in the history; a failed quick check just waits for the next run.
    const message = error instanceof Error ? error.message : String(error);
    await recordSyncStatus(swell, appId, statusMessages.quickCheckFailed(message));
    return { quick_check: 'failed', error: message };
  }
}

function fullSyncStatus(result: {
  status: string;
  created?: number;
  updated?: number;
  removed?: number;
  error?: string;
}): string {
  const { created = 0, updated = 0, removed = 0 } = result;
  if (result.status === 'completed') {
    return statusMessages.fullSyncCompleted(created, updated, removed);
  }
  if (result.status === 'failed') {
    return statusMessages.fullSyncFailed(result.error ?? 'unknown error');
  }
  if (result.error) {
    return statusMessages.quickCheckFailed(result.error);
  }
  return statusMessages.fullSyncRunning(created, updated);
}
