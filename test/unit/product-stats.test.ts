import { describe, it, expect, vi } from 'vitest';
import { createMockRequest } from '../helpers/mock-request';
import { computeProductStats } from '../../functions/lib/product-stats';
import { toTestimonialRecord, withPreviousProduct } from '../../functions/lib/testimonials';
import updateProductStats from '../../functions/update-product-stats';

function testimonialsGet(byProduct: Record<string, { rating?: number | null }[]>) {
  return vi.fn(async (_url: string, query: { where: { product_id: string } }) => ({
    results: byProduct[query.where.product_id] ?? [],
    page_count: 1,
  }));
}

describe('computeProductStats', () => {
  it('counts approved testimonials and averages their ratings to one decimal', async () => {
    const get = testimonialsGet({ p1: [{ rating: 5 }, { rating: 4 }, { rating: 4 }] });
    expect(await computeProductStats({ get } as unknown as SwellAPI, 'p1')).toEqual({
      testimonial_count: 3,
      rating_average: 4.3,
    });
    expect(get).toHaveBeenCalledWith('/testimonials', expect.objectContaining({
      where: { product_id: 'p1', approved: true },
    }));
  });

  it('counts unrated testimonials but leaves them out of the average', async () => {
    const get = testimonialsGet({ p1: [{ rating: 5 }, { rating: null }, {}] });
    expect(await computeProductStats({ get } as unknown as SwellAPI, 'p1')).toEqual({
      testimonial_count: 3,
      rating_average: 5,
    });
  });

  it('returns zero and no average for a product without testimonials', async () => {
    expect(await computeProductStats({ get: testimonialsGet({}) } as unknown as SwellAPI, 'p1')).toEqual({
      testimonial_count: 0,
      rating_average: null,
    });
  });

  it('reads every page for products with many testimonials', async () => {
    const full = Array.from({ length: 1000 }, () => ({ rating: 5 }));
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: full, page_count: 2 })
      .mockResolvedValueOnce({ results: [{ rating: 3 }], page_count: 2 });
    const stats = await computeProductStats({ get } as unknown as SwellAPI, 'p1');
    expect(stats.testimonial_count).toBe(1001);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('update-product-stats', () => {
  function request(data: object, byProduct: Record<string, object[]> = {}, put = vi.fn().mockResolvedValue({})) {
    return createMockRequest({
      data: data as SwellData,
      swell: { get: testimonialsGet(byProduct), put },
    });
  }

  it('saves the stats on the product under the app namespace', async () => {
    const req = request(
      { product_id: 'p1', $event: { type: 'testimonial.created', data: {} } },
      { p1: [{ rating: 5 }, { rating: 3 }] },
    );
    await updateProductStats(req);
    expect(req.swell.put).toHaveBeenCalledWith('/products/p1', {
      $app: { senja: { testimonial_count: 2, rating_average: 4 } },
    });
  });

  it('recalculates both products when a testimonial moves', async () => {
    const req = request({
      product_id: 'p2',
      previous_product_id: 'p1',
      $event: { type: 'testimonial.updated', data: { product_id: 'p2' } },
    });
    await updateProductStats(req);
    expect(req.swell.put).toHaveBeenCalledWith('/products/p2', expect.anything());
    expect(req.swell.put).toHaveBeenCalledWith('/products/p1', expect.anything());
  });

  it('skips updates that do not affect the stats', async () => {
    const req = request({ product_id: 'p1', $event: { type: 'testimonial.updated', data: { text: 'new' } } });
    expect(await updateProductStats(req)).toEqual({ skipped: 'no_stat_change' });
    expect(req.swell.put).not.toHaveBeenCalled();
  });

  it('finds the product in the event snapshot when a testimonial is deleted', async () => {
    const req = request(
      { $event: { type: 'testimonial.deleted', data: { id: 't1', product_id: 'p1', rating: 5 } } },
      { p1: [{ rating: 4 }] },
    );
    await updateProductStats(req);
    expect(req.swell.put).toHaveBeenCalledWith('/products/p1', {
      $app: { senja: { testimonial_count: 1, rating_average: 4 } },
    });
  });

  it('does nothing for testimonials without a product', async () => {
    const req = request({ $event: { type: 'testimonial.deleted', data: {} } });
    expect(await updateProductStats(req)).toEqual({ products: {} });
    expect(req.swell.put).not.toHaveBeenCalled();
  });

  it('ignores a product that no longer exists', async () => {
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const req = request({ product_id: 'gone', $event: { type: 'testimonial.deleted', data: {} } }, {}, put);
    expect(await updateProductStats(req)).toEqual({ products: {} });
  });
});

describe('withPreviousProduct', () => {
  const record = toTestimonialRecord({ id: 's1' }, 'p2');

  it('records the old product when the link changes', () => {
    expect(withPreviousProduct({ product_id: 'p1' }, record)).toMatchObject({ product_id: 'p2', previous_product_id: 'p1' });
    expect(withPreviousProduct({ product_id: 'p1' }, { ...record, product_id: null })).toMatchObject({
      previous_product_id: 'p1',
    });
  });

  it('leaves the record alone when the link is unchanged or new', () => {
    expect(withPreviousProduct({ product_id: 'p2' }, record)).not.toHaveProperty('previous_product_id');
    expect(withPreviousProduct({}, record)).not.toHaveProperty('previous_product_id');
  });
});
