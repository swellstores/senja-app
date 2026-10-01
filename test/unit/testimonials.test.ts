import { describe, it, expect, vi } from 'vitest';
import {
  CLEANUP_PAGE_SIZE,
  removeMissingTestimonials,
  toTestimonialRecord,
  type SenjaTestimonial,
} from '../../functions/lib/testimonials';

const senjaTestimonial: SenjaTestimonial = {
  id: 'senja_1',
  type: 'text',
  title: 'Love it',
  text: 'Great shoes',
  rating: 5,
  approved: true,
  date: '2026-09-01T00:00:00.000Z',
  customer_name: 'Ada',
  customer_email: 'ada@example.com',
  tags: ['blue-sneaker'],
};

describe('toTestimonialRecord', () => {
  it('maps Senja fields onto the Swell record', () => {
    expect(toTestimonialRecord(senjaTestimonial, 'prod_1')).toMatchObject({
      senja_id: 'senja_1',
      type: 'text',
      text: 'Great shoes',
      rating: 5,
      approved: true,
      customer_email: 'ada@example.com',
      tags: ['blue-sneaker'],
      product_id: 'prod_1',
    });
  });

  it('fills safe defaults for missing fields', () => {
    const record = toTestimonialRecord({ id: 'x' }, null);
    expect(record).toMatchObject({ type: 'text', approved: false, rating: null, tags: [], product_id: null });
  });

  it('falls back to created_at for the date and clamps ratings to 0-5', () => {
    const record = toTestimonialRecord({ id: 'x', created_at: '2026-01-01', rating: 9 }, null);
    expect(record.date).toBe('2026-01-01');
    expect(record.rating).toBe(5);
  });
});

describe('removeMissingTestimonials', () => {
  function swellWith(records: { id: string; senja_id: string }[]) {
    return {
      get: vi.fn().mockResolvedValue({ results: records }),
      put: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    } as unknown as SwellAPI & Record<'get' | 'put' | 'delete', ReturnType<typeof vi.fn>>;
  }

  it('deletes copies Senja no longer has and keeps the rest', async () => {
    const swell = swellWith([
      { id: 'w1', senja_id: 's1' },
      { id: 'w2', senja_id: 'gone' },
      { id: 'w3', senja_id: 's3' },
    ]);
    const result = await removeMissingTestimonials(swell, new Set(['s1', 's3']), null);

    expect(result).toEqual({ removed: 1, next_after: null });
    expect(swell.delete).toHaveBeenCalledTimes(1);
    expect(swell.delete).toHaveBeenCalledWith('/testimonials/w2');
  });

  it('walks the collection by id and reports where to continue', async () => {
    const page = Array.from({ length: CLEANUP_PAGE_SIZE }, (_, i) => ({ id: `w${i}`, senja_id: `s${i}` }));
    const swell = swellWith(page);
    const seen = new Set(page.map((r) => r.senja_id));

    expect(await removeMissingTestimonials(swell, seen, 'w_prev')).toEqual({
      removed: 0,
      next_after: `w${CLEANUP_PAGE_SIZE - 1}`,
    });
    expect(swell.get).toHaveBeenCalledWith('/testimonials', {
      where: { id: { $gt: 'w_prev' } },
      fields: 'id,senja_id',
      sort: 'id asc',
      limit: CLEANUP_PAGE_SIZE,
    });
  });
});
