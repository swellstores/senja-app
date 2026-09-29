import { listTestimonials, SenjaApiError } from './lib/senja';
import { syncTestimonialBatch } from './lib/testimonials';

export const config: SwellConfig = {
  description: 'Copy existing testimonials from Senja, resuming across runs',
  cron: {
    schedule: '*/10 * * * *',
  },
  timeout: 10000,
};

export const PAGE_SIZE = 25;
/** Stop starting new pages after this long, leaving headroom under the 10s function limit. */
export const TIME_BUDGET_MS = 6000;
/** How often a full sync runs again, to catch anything a webhook missed. */
export const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed run (e.g. a wrong API key), try again sooner so a fixed key takes effect. */
export const RETRY_FAILED_MS = 60 * 60 * 1000;

interface SyncRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  next_page: number;
  created: number;
  updated: number;
  unchanged: number;
  date_started?: string;
  date_completed?: string;
}

async function latestRun(swell: SwellAPI): Promise<SyncRun | null> {
  const result = (await swell.get('/syncs', { sort: 'date_created desc', limit: 1 })) as {
    results?: SyncRun[];
  } | null;
  return result?.results?.[0] ?? null;
}

/** Returns the run to work on now, or null when nothing is due. */
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
    next_page: 1,
    created: 0,
    updated: 0,
    unchanged: 0,
    date_started: new Date(now).toISOString(),
  })) as SyncRun;
}

export default async function (req: SwellRequest) {
  const clock = () => Date.now();
  const { swell } = req;
  const settings = await swell.settings();
  const apiKey: string | undefined = settings?.connection?.api_key;
  if (!apiKey) {
    return { skipped: 'no_api_key' };
  }

  const startedAt = clock();
  const run = await runToContinue(swell, startedAt);
  if (!run) {
    return { skipped: 'up_to_date' };
  }

  const progress = {
    next_page: run.next_page || 1,
    created: run.created || 0,
    updated: run.updated || 0,
    unchanged: run.unchanged || 0,
  };

  try {
    while (clock() - startedAt < TIME_BUDGET_MS) {
      const { testimonials, hasMore } = await listTestimonials(apiKey, { page: progress.next_page, limit: PAGE_SIZE });
      const counts = await syncTestimonialBatch(swell, testimonials);
      progress.created += counts.created;
      progress.updated += counts.updated;
      progress.unchanged += counts.unchanged;

      if (!hasMore) {
        await swell.put(`/syncs/${run.id}`, {
          ...progress,
          status: 'completed',
          date_completed: new Date(clock()).toISOString(),
          error: null,
        });
        return { id: run.id, status: 'completed', ...progress };
      }
      progress.next_page++;
    }

    await swell.put(`/syncs/${run.id}`, progress);
    return { id: run.id, status: 'running', ...progress };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An auth problem won't fix itself on the next run; other errors (rate limits, outages) are retried.
    const fatal = error instanceof SenjaApiError && (error.status === 401 || error.status === 403);
    await swell.put(`/syncs/${run.id}`, {
      ...progress,
      status: fatal ? 'failed' : 'running',
      error: message,
      ...(fatal ? { date_completed: new Date(clock()).toISOString() } : {}),
    });
    return { id: run.id, status: fatal ? 'failed' : 'running', error: message, ...progress };
  }
}
