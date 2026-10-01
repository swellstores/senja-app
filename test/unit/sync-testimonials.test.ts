import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import handler, {
  PAGE_SIZE,
  QUICK_CHECK_MAX_PAGES,
  RESYNC_INTERVAL_MS,
  RETRY_FAILED_MS,
  runToContinue,
} from '../../functions/sync-testimonials';

const NOW = new Date('2026-09-29T12:00:00.000Z').getTime();

function page(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${offset + i}` }));
}

function senjaPages(pages: object[][]) {
  const fetchMock = vi.fn(async (url: string) => {
    const pageNumber = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ testimonials: pages[pageNumber - 1] ?? [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Swell mock with an in-memory testimonials collection. */
function swellMock({
  latest = null as object | null,
  apiKey = 'key' as string | null,
  stored = [] as { id: string; senja_id: string }[],
} = {}) {
  const testimonials = [...stored];
  let nextId = 1;
  return {
    testimonials,
    settings: vi.fn().mockResolvedValue(apiKey ? { connection: { api_key: apiKey } } : {}),
    get: vi.fn(async (url: string, query: any = {}) => {
      if (url === '/syncs') return { results: latest ? [latest] : [] };
      if (url === '/testimonials') {
        const ids = query.where?.senja_id?.$in;
        if (ids) return { results: testimonials.filter((t) => ids.includes(t.senja_id)) };
        const after = query.where?.id?.$gt;
        const sorted = [...testimonials].sort((a, b) => a.id.localeCompare(b.id));
        return { results: sorted.filter((t) => !after || t.id > after).slice(0, query.limit ?? 1000) };
      }
      return { results: [] };
    }),
    post: vi.fn(async (url: string, data: any) => {
      if (url === '/syncs') return { id: 'run_new', ...data };
      const record = { id: `w${String(nextId++).padStart(4, '0')}`, ...data };
      testimonials.push(record);
      return record;
    }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn(async (url: string) => {
      const id = url.split('/').pop();
      testimonials.splice(testimonials.findIndex((t) => t.id === id), 1);
      return {};
    }),
  };
}

/** The last save to a sync record (the status panel is saved after it). */
function lastSyncPut(swell: { put: ReturnType<typeof vi.fn> }) {
  const calls = swell.put.mock.calls.filter(([url]: [string]) => url.startsWith('/syncs/'));
  return calls[calls.length - 1];
}

function lastStatus(swell: { put: ReturnType<typeof vi.fn> }) {
  const calls = swell.put.mock.calls.filter(([url]: [string]) => url === '/settings/senja');
  return calls[calls.length - 1]?.[1]?.status;
}

const recentRun = { id: 'r', status: 'completed', date_completed: new Date(NOW - 1000).toISOString() };

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runToContinue', () => {
  it('starts the first full sync', async () => {
    const swell = swellMock();
    const run = await runToContinue(swell as unknown as SwellAPI, NOW);
    expect(run?.id).toBe('run_new');
    expect(swell.post).toHaveBeenCalledWith('/syncs', expect.objectContaining({ status: 'running', phase: 'fetch' }));
  });

  it('continues a run that is still going', async () => {
    const latest = { id: 'run_1', status: 'running', next_page: 4 };
    expect(await runToContinue(swellMock({ latest }) as unknown as SwellAPI, NOW)).toEqual(latest);
  });

  it('waits a day after a completed run', async () => {
    const recent = { id: 'r', status: 'completed', date_completed: new Date(NOW - RESYNC_INTERVAL_MS + 60_000).toISOString() };
    expect(await runToContinue(swellMock({ latest: recent }) as unknown as SwellAPI, NOW)).toBeNull();

    const old = { ...recent, date_completed: new Date(NOW - RESYNC_INTERVAL_MS - 60_000).toISOString() };
    expect((await runToContinue(swellMock({ latest: old }) as unknown as SwellAPI, NOW))?.id).toBe('run_new');
  });

  it('retries a failed run after an hour', async () => {
    const failed = { id: 'r', status: 'failed', date_completed: new Date(NOW - RETRY_FAILED_MS - 60_000).toISOString() };
    expect((await runToContinue(swellMock({ latest: failed }) as unknown as SwellAPI, NOW))?.id).toBe('run_new');
  });
});

describe('full sync', () => {
  it('does nothing until the merchant adds an API key, and says so on the settings page', async () => {
    const swell = swellMock({ apiKey: null });
    expect(await handler(createMockRequest({ swell }))).toEqual({ skipped: 'no_api_key' });
    expect(swell.post).not.toHaveBeenCalled();
    expect(lastStatus(swell)).toEqual({
      message: expect.stringContaining('Not connected'),
      last_checked: new Date(NOW).toISOString(),
    });
  });

  it('copies every page, removes testimonials deleted in Senja, and completes', async () => {
    senjaPages([page(PAGE_SIZE), page(3, PAGE_SIZE)]);
    const swell = swellMock({ stored: [{ id: 'w_old', senja_id: 'deleted-in-senja' }] });

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ id: 'run_new', status: 'completed', created: PAGE_SIZE + 3, removed: 1 });
    expect(swell.testimonials.map((t) => t.senja_id)).not.toContain('deleted-in-senja');
    expect(lastStatus(swell).message).toBe(
      `Up to date. The last full sync added ${PAGE_SIZE + 3}, updated 0 and removed 1.`,
    );
    expect(swell.testimonials).toHaveLength(PAGE_SIZE + 3);
    expect(lastSyncPut(swell)).toEqual(['/syncs/run_new', expect.objectContaining({ status: 'completed', removed: 1, seen_ids: [], error: null }),
    ]);
  });

  it('never removes anything when Senja returns no testimonials', async () => {
    senjaPages([[]]);
    const swell = swellMock({ stored: [{ id: 'w1', senja_id: 's1' }] });

    expect(await handler(createMockRequest({ swell }))).toMatchObject({ status: 'completed', removed: 0 });
    expect(swell.delete).not.toHaveBeenCalled();
  });

  it('saves progress and stops when the time budget runs out', async () => {
    senjaPages([page(PAGE_SIZE), page(PAGE_SIZE, PAGE_SIZE), page(1, 2 * PAGE_SIZE)]);
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => NOW + (calls++ > 1 ? 7000 : 0));
    const swell = swellMock();

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ status: 'running', phase: 'fetch', next_page: 2, created: PAGE_SIZE });
    expect(lastSyncPut(swell)).toEqual(['/syncs/run_new', expect.objectContaining({ next_page: 2, seen_ids: page(PAGE_SIZE).map((t) => t.id) }),
    ]);
  });

  it('resumes from the saved page and keeps earlier seen ids', async () => {
    const fetchMock = senjaPages([page(PAGE_SIZE), page(PAGE_SIZE, PAGE_SIZE), page(2, 2 * PAGE_SIZE)]);
    const earlier = page(2 * PAGE_SIZE).map((t) => t.id);
    const stored = earlier.map((senja_id, i) => ({ id: `w${String(i).padStart(4, '0')}`, senja_id }));
    const latest = { id: 'run_1', status: 'running', phase: 'fetch', next_page: 3, created: 50, updated: 0, unchanged: 0, seen_ids: earlier };

    const result = await handler(createMockRequest({ swell: swellMock({ latest, stored }) }));

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('page')).toBe('3');
    expect(result).toMatchObject({ id: 'run_1', status: 'completed', created: 52, removed: 0 });
  });

  it('marks the run failed on an auth error so the merchant sees it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 })));
    const swell = swellMock();

    expect(await handler(createMockRequest({ swell }))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('API key'),
    });
    expect(lastSyncPut(swell)).toEqual(['/syncs/run_new', expect.objectContaining({ status: 'failed' })]);
    expect(lastStatus(swell).message).toMatch(/^Sync failed: .*API key/);
  });

  it('keeps the run going after a temporary error, to retry next time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    expect(await handler(createMockRequest({ swell: swellMock() }))).toMatchObject({
      status: 'running',
      error: expect.stringContaining('503'),
    });
  });
});

describe('quick check between full syncs', () => {
  it('copies new testimonials from the first page', async () => {
    const fetchMock = senjaPages([[{ id: 'new1' }, { id: 'known' }]]);
    const swell = swellMock({ latest: recentRun, stored: [{ id: 'w1', senja_id: 'known' }] });

    const result = await handler(createMockRequest({ swell }));

    expect(result).toEqual({ quick_check: { created: 1, updated: 1, unchanged: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(swell.post).toHaveBeenCalledWith('/testimonials', expect.objectContaining({ senja_id: 'new1' }));
    expect(swell.post).not.toHaveBeenCalledWith('/syncs', expect.anything());
    expect(lastStatus(swell).message).toBe('Up to date. The last check found 1 new testimonial and 1 change.');
  });

  it('keeps reading while whole pages are new, up to a limit', async () => {
    const pages = Array.from({ length: QUICK_CHECK_MAX_PAGES + 2 }, (_, i) => page(PAGE_SIZE, i * PAGE_SIZE));
    const fetchMock = senjaPages(pages);

    const result = await handler(createMockRequest({ swell: swellMock({ latest: recentRun }) }));

    expect(fetchMock).toHaveBeenCalledTimes(QUICK_CHECK_MAX_PAGES);
    expect(result).toEqual({ quick_check: { created: QUICK_CHECK_MAX_PAGES * PAGE_SIZE, updated: 0, unchanged: 0 } });
  });

  it('reports a failed check without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    const swell = swellMock({ latest: recentRun });
    expect(await handler(createMockRequest({ swell }))).toMatchObject({ quick_check: 'failed' });
    expect(lastStatus(swell).message).toMatch(/^Couldn't reach Senja: .*503.*Trying again in 10 minutes\.$/);
  });

  it('says "Up to date." when nothing changed', async () => {
    senjaPages([[{ id: 'known' }]]);
    const stored = [{ id: 'w1', senja_id: 'known', type: 'text', approved: false, tags: [] }];
    const swell = swellMock({ latest: recentRun, stored: stored as any });
    await handler(createMockRequest({ swell }));
    expect(lastStatus(swell).message).toBe('Up to date.');
  });

  it('keeps syncing when the status cannot be saved', async () => {
    senjaPages([[{ id: 'new1' }]]);
    const swell = swellMock({ latest: recentRun });
    swell.put.mockImplementation(async (url: string) => {
      if (url.startsWith('/settings/')) throw new Error('forbidden');
      return {};
    });
    expect(await handler(createMockRequest({ swell }))).toEqual({ quick_check: { created: 1, updated: 0, unchanged: 0 } });
  });
});
