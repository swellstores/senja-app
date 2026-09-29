import { describe, it, expect, vi } from 'vitest';
import {
  deleteTestimonial,
  findProductIdForTags,
  toTestimonialRecord,
  upsertTestimonial,
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

function swellMock(overrides: Partial<Record<'get' | 'post' | 'put' | 'delete', ReturnType<typeof vi.fn>>> = {}) {
  return {
    get: vi.fn().mockResolvedValue({ results: [] }),
    post: vi.fn().mockResolvedValue({ id: 'swell_new' }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as SwellAPI & Record<'get' | 'post' | 'put' | 'delete', ReturnType<typeof vi.fn>>;
}

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

describe('findProductIdForTags', () => {
  it('returns null without calling Swell when there are no tags', async () => {
    const swell = swellMock();
    expect(await findProductIdForTags(swell, [])).toBeNull();
    expect(await findProductIdForTags(swell, undefined)).toBeNull();
    expect(swell.get).not.toHaveBeenCalled();
  });

  it('looks up products by slug or SKU', async () => {
    const swell = swellMock({ get: vi.fn().mockResolvedValue({ results: [{ id: 'prod_1' }] }) });
    expect(await findProductIdForTags(swell, [' blue-sneaker '])).toBe('prod_1');
    expect(swell.get).toHaveBeenCalledWith('/products', {
      where: { $or: [{ slug: { $in: ['blue-sneaker'] } }, { sku: { $in: ['blue-sneaker'] } }] },
      fields: 'id',
      limit: 1,
    });
  });
});

describe('upsertTestimonial', () => {
  it('creates a record when the testimonial is new', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: 'prod_1' }] }) // product lookup
      .mockResolvedValueOnce({ results: [] }); // existing testimonial lookup
    const swell = swellMock({ get });

    expect(await upsertTestimonial(swell, senjaTestimonial)).toEqual({ action: 'created', id: 'swell_new' });
    expect(swell.post).toHaveBeenCalledWith(
      '/testimonials',
      expect.objectContaining({ senja_id: 'senja_1', product_id: 'prod_1' }),
    );
  });

  it('updates the existing record when the testimonial was already copied', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ id: 'swell_1', senja_id: 'senja_1' }] });
    const swell = swellMock({ get });

    expect(await upsertTestimonial(swell, senjaTestimonial)).toEqual({ action: 'updated', id: 'swell_1' });
    expect(swell.put).toHaveBeenCalledWith(
      '/testimonials/swell_1',
      expect.objectContaining({ senja_id: 'senja_1', product_id: null }),
    );
    expect(swell.post).not.toHaveBeenCalled();
  });
});

describe('deleteTestimonial', () => {
  it('deletes the Swell copy', async () => {
    const swell = swellMock({ get: vi.fn().mockResolvedValue({ results: [{ id: 'swell_1' }] }) });
    expect(await deleteTestimonial(swell, 'senja_1')).toEqual({ action: 'deleted', id: 'swell_1' });
    expect(swell.delete).toHaveBeenCalledWith('/testimonials/swell_1');
  });

  it('does nothing when there is no copy', async () => {
    const swell = swellMock();
    expect(await deleteTestimonial(swell, 'senja_1')).toEqual({ action: 'not_found' });
    expect(swell.delete).not.toHaveBeenCalled();
  });
});
