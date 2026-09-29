import { afterEach, describe, it, expect, vi } from 'vitest';
import { listTestimonials, SenjaApiError, sendInvites } from '../../functions/lib/senja';

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listTestimonials', () => {
  it('requests one page, newest first, with the API key', async () => {
    const fetchMock = mockFetch(200, { total: 2, testimonials: [{ id: 'a' }, { id: 'b' }] });
    const result = await listTestimonials('key_123', { page: 3, limit: 25 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.senja.io/v1/testimonials?page=3&limit=25&sort=date&order=desc');
    expect(init.headers.Authorization).toBe('Bearer key_123');
    expect(result).toEqual({ testimonials: [{ id: 'a' }, { id: 'b' }], hasMore: false });
  });

  it('reports more pages when the page is full', async () => {
    mockFetch(200, { total: 2, testimonials: [{ id: 'a' }, { id: 'b' }] });
    expect((await listTestimonials('key', { page: 1, limit: 2 })).hasMore).toBe(true);
  });

  it('treats a missing list as empty', async () => {
    mockFetch(200, {});
    expect(await listTestimonials('key', { page: 1, limit: 25 })).toEqual({ testimonials: [], hasMore: false });
  });

  it('explains auth failures, including the plan requirement', async () => {
    mockFetch(401, { message: 'Unauthorized' });
    const error = await listTestimonials('bad', { page: 1, limit: 25 }).catch((e) => e);
    expect(error).toBeInstanceOf(SenjaApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('Unauthorized');
    expect(error.message).toContain('Starter plan');
  });

  it('surfaces other API errors with their status', async () => {
    mockFetch(500, 'upstream down');
    await expect(listTestimonials('key', { page: 1, limit: 25 })).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('upstream down'),
    });
  });
});

describe('sendInvites', () => {
  it('posts the form and recipients and returns the result from Senja', async () => {
    const fetchMock = mockFetch(200, { sent: 1, skipped: [{ email: 'b@x.com', reason: 'already_invited' }] });
    const result = await sendInvites('key', 'form_1', [{ email: 'a@x.com', name: 'Ada' }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.senja.io/v1/invites');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ form_id: 'form_1', recipients: [{ email: 'a@x.com', name: 'Ada' }] });
    expect(result).toEqual({ sent: 1, skipped: [{ email: 'b@x.com', reason: 'already_invited' }] });
  });
});
