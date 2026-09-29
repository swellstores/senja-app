/** Testimonial as returned by the Senja API and webhooks (fields the app uses). */
export interface SenjaTestimonial {
  id: string;
  type?: 'text' | 'video';
  title?: string | null;
  text?: string | null;
  rating?: number | null;
  approved?: boolean;
  date?: string | null;
  created_at?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_avatar?: string | null;
  customer_company?: string | null;
  customer_tagline?: string | null;
  tags?: string[] | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  url?: string | null;
  integration?: string | null;
}

export interface TestimonialRecord {
  id?: string;
  senja_id: string;
  type: 'text' | 'video';
  title: string | null;
  text: string | null;
  rating: number | null;
  approved: boolean;
  date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_avatar: string | null;
  customer_company: string | null;
  customer_tagline: string | null;
  tags: string[];
  video_url: string | null;
  thumbnail_url: string | null;
  url: string | null;
  integration: string | null;
  product_id: string | null;
}

function clampRating(rating: number | null | undefined): number | null {
  if (typeof rating !== 'number' || Number.isNaN(rating)) {
    return null;
  }
  return Math.min(5, Math.max(0, Math.round(rating)));
}

export function toTestimonialRecord(
  testimonial: SenjaTestimonial,
  productId: string | null,
): TestimonialRecord {
  return {
    senja_id: testimonial.id,
    type: testimonial.type === 'video' ? 'video' : 'text',
    title: testimonial.title ?? null,
    text: testimonial.text ?? null,
    rating: clampRating(testimonial.rating),
    approved: testimonial.approved === true,
    date: testimonial.date ?? testimonial.created_at ?? null,
    customer_name: testimonial.customer_name ?? null,
    customer_email: testimonial.customer_email ?? null,
    customer_avatar: testimonial.customer_avatar ?? null,
    customer_company: testimonial.customer_company ?? null,
    customer_tagline: testimonial.customer_tagline ?? null,
    tags: testimonial.tags ?? [],
    video_url: testimonial.video_url ?? null,
    thumbnail_url: testimonial.thumbnail_url ?? null,
    url: testimonial.url ?? null,
    integration: testimonial.integration ?? null,
    product_id: productId,
  };
}

/** A testimonial is linked to the first product whose slug or SKU matches one of its Senja tags. */
export async function findProductIdForTags(
  swell: SwellAPI,
  tags: string[] | null | undefined,
): Promise<string | null> {
  const values = (tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  if (!values.length) {
    return null;
  }
  const result = (await swell.get('/products', {
    where: { $or: [{ slug: { $in: values } }, { sku: { $in: values } }] },
    fields: 'id',
    limit: 1,
  })) as { results?: { id: string }[] } | null;
  return result?.results?.[0]?.id ?? null;
}

async function findBySenjaId(swell: SwellAPI, senjaId: string): Promise<TestimonialRecord | null> {
  const result = (await swell.get('/testimonials', {
    where: { senja_id: senjaId },
    limit: 1,
  })) as { results?: TestimonialRecord[] } | null;
  return result?.results?.[0] ?? null;
}

/** Create or update the Swell copy of a Senja testimonial. */
export async function upsertTestimonial(
  swell: SwellAPI,
  testimonial: SenjaTestimonial,
): Promise<{ action: 'created' | 'updated'; id: string }> {
  const productId = await findProductIdForTags(swell, testimonial.tags);
  const record = toTestimonialRecord(testimonial, productId);
  const existing = await findBySenjaId(swell, testimonial.id);

  if (existing?.id) {
    await swell.put(`/testimonials/${existing.id}`, record);
    return { action: 'updated', id: existing.id };
  }
  const created = (await swell.post('/testimonials', record)) as { id: string };
  return { action: 'created', id: created.id };
}

/** Remove the Swell copy of a Senja testimonial, if there is one. */
export async function deleteTestimonial(
  swell: SwellAPI,
  senjaId: string,
): Promise<{ action: 'deleted' | 'not_found'; id?: string }> {
  const existing = await findBySenjaId(swell, senjaId);
  if (!existing?.id) {
    return { action: 'not_found' };
  }
  await swell.delete(`/testimonials/${existing.id}`);
  return { action: 'deleted', id: existing.id };
}

const SYNCED_FIELDS: (keyof TestimonialRecord)[] = [
  'type',
  'title',
  'text',
  'rating',
  'approved',
  'date',
  'customer_name',
  'customer_email',
  'customer_avatar',
  'customer_company',
  'customer_tagline',
  'tags',
  'video_url',
  'thumbnail_url',
  'url',
  'integration',
  'product_id',
];

function normalize(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return 'null';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return String(new Date(value).getTime());
  }
  return JSON.stringify(value);
}

export function hasChanges(existing: Partial<TestimonialRecord>, next: TestimonialRecord): boolean {
  return SYNCED_FIELDS.some((field) => normalize(existing[field]) !== normalize(next[field]));
}

/** Map every tag in the batch to a product id, using one query. */
async function productIdsByTag(swell: SwellAPI, testimonials: SenjaTestimonial[]): Promise<Map<string, string>> {
  const tags = [...new Set(testimonials.flatMap((t) => (t.tags ?? []).map((tag) => tag.trim()).filter(Boolean)))];
  const byTag = new Map<string, string>();
  if (!tags.length) {
    return byTag;
  }
  const result = (await swell.get('/products', {
    where: { $or: [{ slug: { $in: tags } }, { sku: { $in: tags } }] },
    fields: 'id,slug,sku',
    limit: 1000,
  })) as { results?: { id: string; slug?: string; sku?: string }[] } | null;

  for (const product of result?.results ?? []) {
    for (const key of [product.slug, product.sku]) {
      if (key && !byTag.has(key)) {
        byTag.set(key, product.id);
      }
    }
  }
  return byTag;
}

export interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
}

/** Create or update Swell copies for a page of Senja testimonials, skipping ones that haven't changed. */
export async function syncTestimonialBatch(
  swell: SwellAPI,
  testimonials: SenjaTestimonial[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0 };
  if (!testimonials.length) {
    return counts;
  }

  const [byTag, existingResult] = await Promise.all([
    productIdsByTag(swell, testimonials),
    swell.get('/testimonials', {
      where: { senja_id: { $in: testimonials.map((t) => t.id) } },
      limit: testimonials.length,
    }) as Promise<{ results?: TestimonialRecord[] } | null>,
  ]);
  const existingBySenjaId = new Map((existingResult?.results ?? []).map((r) => [r.senja_id, r]));

  for (const testimonial of testimonials) {
    const productId = (testimonial.tags ?? []).map((tag) => byTag.get(tag.trim())).find(Boolean) ?? null;
    const record = toTestimonialRecord(testimonial, productId);
    const existing = existingBySenjaId.get(testimonial.id);

    if (!existing?.id) {
      await swell.post('/testimonials', record);
      counts.created++;
    } else if (hasChanges(existing, record)) {
      await swell.put(`/testimonials/${existing.id}`, record);
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }
  return counts;
}
