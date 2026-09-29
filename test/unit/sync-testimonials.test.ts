import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import handler, { PAGE_SIZE, RESYNC_INTERVAL_MS, RETRY_FAILED_MS, runToContinue } from '../../functions/sync-testimonials';

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

function swellMock({ latest = null as object | null, apiKey = 'key' as string | null } = {}) {
  return {
    settings: vi.fn().mockResolvedValue(apiKey ? { connection: { api_key: apiKey } } : {}),
    get: vi.fn(async (url: string) => {
      if (url === '/syncs') return { results: latest ? [latest] : [] };
      return { results: [] };
    }),
    post: vi.fn(async (url: string, data: object) => (url === '/syncs' ? { id: 'run_new', ...data } : { id: 'x' })),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runToContinue', () => {
  it('starts the first run', async () => {
    const swell = swellMock();
    const run = await runToContinue(swell as unknown as SwellAPI, NOW);
    expect(run?.id).toBe('run_new');
    expect(swell.post).toHaveBeenCalledWith('/syncs', expect.objectContaining({ status: 'running', next_page: 1 }));
  });

  it('continues a run that is still going', async () => {
    const latest = { id: 'run_1', status: 'running', next_page: 4 };
    const run = await runToContinue(swellMock({ latest }) as unknown as SwellAPI, NOW);
    expect(run).toEqual(latest);
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

describe('sync-testimonials', () => {
  it('does nothing until the merchant adds an API key', async () => {
    const swell = swellMock({ apiKey: null });
    expect(await handler(createMockRequest({ swell }))).toEqual({ skipped: 'no_api_key' });
    expect(swell.post).not.toHaveBeenCalled();
  });

  it('does nothing when the last sync is recent', async () => {
    const latest = { id: 'r', status: 'completed', date_completed: new Date(NOW - 1000).toISOString() };
    expect(await handler(createMockRequest({ swell: swellMock({ latest }) }))).toEqual({ skipped: 'up_to_date' });
  });

  it('copies every page and completes the run', async () => {
    senjaPages([page(PAGE_SIZE), page(3, PAGE_SIZE)]);
    const swell = swellMock();

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ id: 'run_new', status: 'completed', created: PAGE_SIZE + 3 });
    expect(swell.put).toHaveBeenLastCalledWith(
      '/syncs/run_new',
      expect.objectContaining({ status: 'completed', created: PAGE_SIZE + 3, error: null }),
    );
  });

  it('saves progress and stops when the time budget runs out', async () => {
    senjaPages([page(PAGE_SIZE), page(PAGE_SIZE, PAGE_SIZE), page(1, 2 * PAGE_SIZE)]);
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => NOW + (calls++ > 1 ? 7000 : 0));
    const swell = swellMock();

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ status: 'running', next_page: 2, created: PAGE_SIZE });
    expect(swell.put).toHaveBeenLastCalledWith('/syncs/run_new', expect.objectContaining({ next_page: 2 }));
  });

  it('resumes from the saved page', async () => {
    const fetchMock = senjaPages([page(PAGE_SIZE), page(PAGE_SIZE, PAGE_SIZE), page(2, 2 * PAGE_SIZE)]);
    const latest = { id: 'run_1', status: 'running', next_page: 3, created: 50, updated: 0, unchanged: 0 };

    const result = await handler(createMockRequest({ swell: swellMock({ latest }) }));

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('page')).toBe('3');
    expect(result).toMatchObject({ id: 'run_1', status: 'completed', created: 52 });
  });

  it('marks the run failed on an auth error so the merchant sees it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"Unauthorized"}', { status: 401 })));
    const swell = swellMock();

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('API key') });
    expect(swell.put).toHaveBeenLastCalledWith('/syncs/run_new', expect.objectContaining({ status: 'failed' }));
  });

  it('keeps the run going after a temporary error, to retry next time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    const swell = swellMock();

    const result = await handler(createMockRequest({ swell }));

    expect(result).toMatchObject({ status: 'running', error: expect.stringContaining('503') });
  });
});
