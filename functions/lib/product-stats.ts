export interface ProductStats {
  testimonial_count: number;
  rating_average: number | null;
}

const PAGE_LIMIT = 1000;

/** Count and average rating of the approved testimonials linked to a product. */
export async function computeProductStats(swell: SwellAPI, productId: string): Promise<ProductStats> {
  let count = 0;
  let ratingSum = 0;
  let ratingCount = 0;

  for (let page = 1; ; page++) {
    const result = (await swell.get('/testimonials', {
      where: { product_id: productId, approved: true },
      fields: 'rating',
      limit: PAGE_LIMIT,
      page,
    })) as { results?: { rating?: number | null }[]; page_count?: number } | null;
    const results = result?.results ?? [];

    for (const { rating } of results) {
      count++;
      if (typeof rating === 'number' && rating > 0) {
        ratingSum += rating;
        ratingCount++;
      }
    }
    if (results.length < PAGE_LIMIT || page >= (result?.page_count ?? page)) {
      break;
    }
  }

  return {
    testimonial_count: count,
    rating_average: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
  };
}

/** Recalculate and save the stats for each product, skipping empty ids and duplicates. */
export async function refreshProductStats(
  req: SwellRequest,
  productIds: (string | null | undefined)[],
): Promise<Record<string, ProductStats>> {
  const unique = [...new Set(productIds.filter((id): id is string => Boolean(id)))];
  const saved: Record<string, ProductStats> = {};

  for (const productId of unique) {
    const stats = await computeProductStats(req.swell, productId);
    try {
      await req.swell.put(`/products/${productId}`, req.appValues(stats));
      saved[productId] = stats;
    } catch (error) {
      // The product may have been deleted since the testimonial was linked to it.
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }
  }
  return saved;
}
