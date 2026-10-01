import { describe, it, expect, vi } from 'vitest';
import { hasChanges, syncTestimonialBatch, toTestimonialRecord } from '../../functions/lib/testimonials';

function swellWith({ products = [], existing = [] }: { products?: object[]; existing?: object[] }) {
  const get = vi.fn(async (url: string) => {
    if (url === '/products') return { results: products };
    if (url === '/testimonials') return { results: existing };
    throw new Error(`unexpected GET ${url}`);
  });
  return {
    get,
    post: vi.fn().mockResolvedValue({ id: 'new' }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn(),
  } as unknown as SwellAPI & Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
}

describe('hasChanges', () => {
  const record = toTestimonialRecord({ id: 's1', text: 'Hi', rating: 5, date: '2026-09-01T00:00:00.000Z' }, null);

  it('is false when only formatting differs (null vs missing, date precision)', () => {
    expect(hasChanges({ ...record, title: undefined, date: '2026-09-01T00:00:00Z' }, record)).toBe(false);
  });

  it('is true when a synced field changed', () => {
    expect(hasChanges({ ...record, approved: true }, record)).toBe(true);
    expect(hasChanges({ ...record, tags: ['x'] }, record)).toBe(true);
  });
});

describe('syncTestimonialBatch', () => {
  it('does nothing for an empty page', async () => {
    const swell = swellWith({});
    expect(await syncTestimonialBatch(swell, [])).toEqual({ created: 0, updated: 0, unchanged: 0 });
    expect(swell.get).not.toHaveBeenCalled();
  });

  it('creates new, updates changed and skips unchanged testimonials', async () => {
    const unchanged = toTestimonialRecord({ id: 's2', text: 'Same' }, null);
    const swell = swellWith({
      existing: [
        { ...toTestimonialRecord({ id: 's1', text: 'Old' }, null), id: 'w1' },
        { ...unchanged, id: 'w2' },
      ],
    });

    const counts = await syncTestimonialBatch(swell, [
      { id: 's1', text: 'New' },
      { id: 's2', text: 'Same' },
      { id: 's3', text: 'Brand new' },
    ]);

    expect(counts).toEqual({ created: 1, updated: 1, unchanged: 1 });
    expect(swell.put).toHaveBeenCalledWith('/testimonials/w1', expect.objectContaining({ text: 'New' }));
    expect(swell.post).toHaveBeenCalledWith('/testimonials', expect.objectContaining({ senja_id: 's3' }));
  });

  it('looks up products and existing copies once per page, and links by slug or SKU', async () => {
    const swell = swellWith({
      products: [
        { id: 'p1', name: 'Blue Sneaker', slug: 'blue-sneaker', sku: 'SKU-1' },
        { id: 'p2', name: 'Red Hat', slug: 'red-hat', sku: 'SKU-2' },
      ],
    });

    await syncTestimonialBatch(swell, [
      { id: 's1', tags: ['blue-sneaker'] },
      { id: 's2', tags: ['vip', 'SKU-2'] },
      { id: 's3', tags: ['unknown'] },
    ]);

    expect(swell.get).toHaveBeenCalledTimes(2);
    const posted = swell.post.mock.calls.map(([, record]) => [record.senja_id, record.product_id, record.product_name]);
    expect(posted).toEqual([
      ['s1', 'p1', 'Blue Sneaker'],
      ['s2', 'p2', 'Red Hat'],
      ['s3', null, null],
    ]);
  });
});
