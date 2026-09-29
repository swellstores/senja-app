import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import { DAY_MS, readInviteSettings } from '../../functions/lib/invites';
import scheduleInvite from '../../functions/schedule-invite';
import sendInvite from '../../functions/send-invite';

const NOW = new Date('2026-09-29T12:00:00.000Z').getTime();

const configured = {
  connection: { api_key: 'key_1' },
  invites: { enabled: true, form_id: 'form_1', delay_days: 7 },
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readInviteSettings', () => {
  it('reads and trims the settings', () => {
    expect(
      readInviteSettings({
        connection: { api_key: ' k ' },
        invites: { enabled: true, form_id: ' f ', delay_days: 3, only_opted_in: true },
      }),
    ).toEqual({ enabled: true, formId: 'f', delayDays: 3, onlyOptedIn: true, apiKey: 'k' });
  });

  it('defaults to off, 7 days, and no key', () => {
    expect(readInviteSettings({})).toEqual({
      enabled: false,
      formId: null,
      delayDays: 7,
      onlyOptedIn: false,
      apiKey: null,
    });
  });

  it('keeps the delay between 0 and 90 whole days', () => {
    expect(readInviteSettings({ invites: { delay_days: 200 } }).delayDays).toBe(90);
    expect(readInviteSettings({ invites: { delay_days: 2.7 } }).delayDays).toBe(2);
    expect(readInviteSettings({ invites: { delay_days: -1 } }).delayDays).toBe(7);
    expect(readInviteSettings({ invites: { delay_days: 0 } }).delayDays).toBe(0);
  });
});

describe('schedule-invite', () => {
  function request({
    settings = configured as object,
    account = { email: 'ada@example.com', name: 'Ada Lovelace', email_optin: false } as object | null,
    existing = [] as object[],
    data = { id: 'order_1', account_id: 'acc_1', billing: { name: 'A. Lovelace' } } as object,
  } = {}) {
    return createMockRequest({
      data: data as SwellData,
      swell: {
        settings: vi.fn().mockResolvedValue(settings),
        get: vi.fn(async (url: string) => (url === '/invites' ? { results: existing } : account)),
        post: vi.fn(async (_url: string, body: object) => ({ id: 'inv_1', ...body })),
      },
    });
  }

  it('schedules an invite N days after delivery', async () => {
    const req = request();
    const result = await scheduleInvite(req);

    const expectedDate = new Date(NOW + 7 * DAY_MS).toISOString();
    expect(result).toEqual({ scheduled: 'inv_1', date_scheduled: expectedDate });
    expect(req.swell.post).toHaveBeenCalledWith('/invites', {
      order_id: 'order_1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      form_id: 'form_1',
      status: 'scheduled',
      date_scheduled: expectedDate,
    });
  });

  it('falls back to the billing name', async () => {
    const req = request({ account: { email: 'ada@example.com' } });
    await scheduleInvite(req);
    expect(req.swell.post).toHaveBeenCalledWith('/invites', expect.objectContaining({ name: 'A. Lovelace' }));
  });

  it('does nothing while invites are off', async () => {
    const req = request({ settings: { ...configured, invites: { ...configured.invites, enabled: false } } });
    expect(await scheduleInvite(req)).toEqual({ skipped: 'invites_off' });
    expect(req.swell.post).not.toHaveBeenCalled();
  });

  it('does nothing until the API key and form are set', async () => {
    expect(await scheduleInvite(request({ settings: { invites: { enabled: true } } }))).toEqual({
      skipped: 'not_configured',
    });
  });

  it('skips orders without a customer email', async () => {
    expect(await scheduleInvite(request({ account: {} }))).toEqual({ skipped: 'no_email' });
    expect(await scheduleInvite(request({ data: { id: 'order_1' } }))).toEqual({ skipped: 'no_customer' });
  });

  it('respects the marketing opt-in setting', async () => {
    const settings = { ...configured, invites: { ...configured.invites, only_opted_in: true } };
    expect(await scheduleInvite(request({ settings }))).toEqual({ skipped: 'not_opted_in' });

    const optedIn = request({ settings, account: { email: 'ada@example.com', email_optin: true } });
    expect(await scheduleInvite(optedIn)).toMatchObject({ scheduled: 'inv_1' });
  });

  it('never schedules two invites for the same order', async () => {
    const req = request({ existing: [{ id: 'inv_0' }] });
    expect(await scheduleInvite(req)).toEqual({ skipped: 'already_scheduled', id: 'inv_0' });
    expect(req.swell.post).not.toHaveBeenCalled();
  });
});

describe('send-invite', () => {
  const dueInvite = {
    id: 'inv_1',
    order_id: 'order_1',
    email: 'ada@example.com',
    name: 'Ada',
    form_id: 'form_1',
    status: 'scheduled',
    date_scheduled: new Date(NOW - 1000).toISOString(),
  };

  function request({ invite = dueInvite as object | null, settings = configured as object } = {}) {
    return createMockRequest({
      data: { id: 'inv_1' },
      swell: {
        settings: vi.fn().mockResolvedValue(settings),
        get: vi.fn().mockResolvedValue(invite),
        put: vi.fn().mockResolvedValue({}),
      },
    });
  }

  function senjaResponds(status: number, body: object | string) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends the invite through Senja and marks it sent', async () => {
    const fetchMock = senjaResponds(200, { sent: 1, skipped: [] });
    const req = request();

    expect(await sendInvite(req)).toEqual({ status: 'sent' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      form_id: 'form_1',
      recipients: [{ email: 'ada@example.com', name: 'Ada' }],
    });
    expect(req.swell.put).toHaveBeenCalledWith('/invites/inv_1', {
      status: 'sent',
      date_sent: new Date(NOW).toISOString(),
      error: null,
    });
  });

  it('records why Senja skipped the invite', async () => {
    senjaResponds(200, { sent: 0, skipped: [{ email: 'ada@example.com', reason: 'already_invited' }] });
    const req = request();

    expect(await sendInvite(req)).toEqual({ status: 'skipped', reason: 'already_invited' });
    expect(req.swell.put).toHaveBeenCalledWith('/invites/inv_1', { status: 'skipped', error: 'already_invited' });
  });

  it('ignores invites that are no longer scheduled or not yet due', async () => {
    expect(await sendInvite(request({ invite: { ...dueInvite, status: 'sent' } }))).toEqual({
      skipped: 'not_scheduled',
    });
    expect(await sendInvite(request({ invite: null }))).toEqual({ skipped: 'not_scheduled' });
    const future = { ...dueInvite, date_scheduled: new Date(NOW + DAY_MS).toISOString() };
    expect(await sendInvite(request({ invite: future }))).toEqual({ skipped: 'not_due' });
  });

  it('skips the invite if invites were turned off before it was due', async () => {
    const req = request({ settings: { ...configured, invites: { ...configured.invites, enabled: false } } });
    expect(await sendInvite(req)).toEqual({ status: 'skipped' });
    expect(req.swell.put).toHaveBeenCalledWith('/invites/inv_1', expect.objectContaining({ status: 'skipped' }));
  });

  it('fails with a clear message when the API key is missing', async () => {
    const req = request({ settings: { invites: configured.invites } });
    expect(await sendInvite(req)).toEqual({ status: 'failed' });
    expect(req.swell.put).toHaveBeenCalledWith(
      '/invites/inv_1',
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('API key') }),
    );
  });

  it('marks the invite failed when Senja rejects the request', async () => {
    senjaResponds(401, { message: 'Unauthorized' });
    const req = request();
    expect(await sendInvite(req)).toMatchObject({ status: 'failed' });
    expect(req.swell.put).toHaveBeenCalledWith('/invites/inv_1', expect.objectContaining({ status: 'failed' }));
  });

  it('throws on rate limits and outages so the platform retries', async () => {
    senjaResponds(429, 'slow down');
    await expect(sendInvite(request())).rejects.toMatchObject({ status: 429 });

    senjaResponds(503, 'down');
    const req = request();
    await expect(sendInvite(req)).rejects.toMatchObject({ status: 503 });
    expect(req.swell.put).not.toHaveBeenCalled();
  });
});
