import { describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import { hmacSha256Hex } from '../../functions/lib/signature';
import { post } from '../../functions/senja-webhook';

const secret = 'test-secret';

async function webhookRequest(
  event: object,
  {
    signWith = secret,
    settings = { connection: { webhook_secret: secret } },
    swell = {},
  }: { signWith?: string | null; settings?: object; swell?: Partial<Record<string, unknown>> } = {},
) {
  const rawBody = JSON.stringify(event);
  const headers: Record<string, string> = {};
  if (signWith) {
    headers['x-senja-signature'] = await hmacSha256Hex(signWith, rawBody);
  }
  const req = createMockRequest({
    data: event as SwellData,
    headers,
    swell: {
      settings: vi.fn().mockResolvedValue(settings),
      get: vi.fn().mockResolvedValue({ results: [] }),
      post: vi.fn().mockResolvedValue({ id: 'swell_new' }),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      ...swell,
    },
  });
  (req as { rawBody: string }).rawBody = rawBody;
  return req;
}

const created = { type: 'testimonial_created', data: { new: { id: 'senja_1', customer_name: 'Ada', approved: true } } };

describe('senja-webhook', () => {
  it('copies a new testimonial into Swell', async () => {
    const req = await webhookRequest(created);
    expect(await post(req)).toEqual({ ok: true, action: 'created', id: 'swell_new' });
    expect(req.swell.post).toHaveBeenCalledWith('/testimonials', expect.objectContaining({ senja_id: 'senja_1' }));
  });

  it('updates the copy on testimonial_updated', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: 'swell_1' }] });
    const req = await webhookRequest(
      { type: 'testimonial_updated', data: { old: { id: 'senja_1' }, new: { id: 'senja_1', approved: false } } },
      { swell: { get } },
    );
    expect(await post(req)).toEqual({ ok: true, action: 'updated', id: 'swell_1' });
    expect(req.swell.put).toHaveBeenCalledWith('/testimonials/swell_1', expect.objectContaining({ approved: false }));
  });

  it('deletes the copy on testimonial_deleted', async () => {
    const req = await webhookRequest(
      { type: 'testimonial_deleted', data: { old: { id: 'senja_1' } } },
      { swell: { get: vi.fn().mockResolvedValue({ results: [{ id: 'swell_1' }] }) } },
    );
    expect(await post(req)).toEqual({ ok: true, action: 'deleted', id: 'swell_1' });
    expect(req.swell.delete).toHaveBeenCalledWith('/testimonials/swell_1');
  });

  it('acknowledges unknown event types without writing anything', async () => {
    const req = await webhookRequest({ type: 'form_submitted', data: {} });
    expect(await post(req)).toEqual({ ok: true, action: 'ignored', type: 'form_submitted' });
    expect(req.swell.post).not.toHaveBeenCalled();
  });

  it('rejects requests with a wrong signature', async () => {
    const req = await webhookRequest(created, { signWith: 'wrong-secret' });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
    expect(req.swell.post).not.toHaveBeenCalled();
  });

  it('rejects requests without a signature', async () => {
    const req = await webhookRequest(created, { signWith: null });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses events until the merchant sets a webhook secret', async () => {
    const req = await webhookRequest(created, { settings: {} });
    await expect(post(req)).rejects.toMatchObject({ status: 503 });
  });

  it('returns 400 when a created event has no testimonial', async () => {
    const req = await webhookRequest({ type: 'testimonial_created', data: {} });
    await expect(post(req)).rejects.toMatchObject({ status: 400 });
  });
});
