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
  /** Shown as plain text in the dashboard; the product picker can't be made read-only. */
  product_name: string | null;
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
  productName: string | null = null,
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
    product_name: productId ? productName : null,
  };
}

/** When the linked product changes, remember the old one so its stats get recalculated too. */
export function withPreviousProduct(
  existing: Partial<TestimonialRecord>,
  record: TestimonialRecord,
): TestimonialRecord & { previous_product_id?: string | null } {
  const previous = existing.product_id ?? null;
  if (previous && previous !== record.product_id) {
    return { ...record, previous_product_id: previous };
  }
  return record;
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
  'product_name',
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

interface TaggedProduct {
  id: string;
  name: string | null;
}

/** Map every tag in the batch to a product, using one query. */
async function productsByTag(swell: SwellAPI, testimonials: SenjaTestimonial[]): Promise<Map<string, TaggedProduct>> {
  const tags = [...new Set(testimonials.flatMap((t) => (t.tags ?? []).map((tag) => tag.trim()).filter(Boolean)))];
  const byTag = new Map<string, TaggedProduct>();
  if (!tags.length) {
    return byTag;
  }
  const result = (await swell.get('/products', {
    where: { $or: [{ slug: { $in: tags } }, { sku: { $in: tags } }] },
    fields: 'id,name,slug,sku',
    limit: 1000,
  })) as { results?: { id: string; name?: string; slug?: string; sku?: string }[] } | null;

  for (const product of result?.results ?? []) {
    for (const key of [product.slug, product.sku]) {
      if (key && !byTag.has(key)) {
        byTag.set(key, { id: product.id, name: product.name ?? null });
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
    productsByTag(swell, testimonials),
    swell.get('/testimonials', {
      where: { senja_id: { $in: testimonials.map((t) => t.id) } },
      limit: testimonials.length,
    }) as Promise<{ results?: TestimonialRecord[] } | null>,
  ]);
  const existingBySenjaId = new Map((existingResult?.results ?? []).map((r) => [r.senja_id, r]));

  for (const testimonial of testimonials) {
    const product = (testimonial.tags ?? []).map((tag) => byTag.get(tag.trim())).find(Boolean) ?? null;
    const record = toTestimonialRecord(testimonial, product?.id ?? null, product?.name ?? null);
    const existing = existingBySenjaId.get(testimonial.id);

    if (!existing?.id) {
      await swell.post('/testimonials', record);
      counts.created++;
    } else if (hasChanges(existing, record)) {
      await swell.put(`/testimonials/${existing.id}`, withPreviousProduct(existing, record));
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }
  return counts;
}

export const CLEANUP_PAGE_SIZE = 500;

/**
 * Delete Swell copies whose Senja testimonial no longer exists. Walks the collection by id so
 * deletions don't shift later pages. Returns the id to continue after, or null when done.
 */
export async function removeMissingTestimonials(
  swell: SwellAPI,
  seenSenjaIds: Set<string>,
  after: string | null,
): Promise<{ removed: number; next_after: string | null }> {
  const result = (await swell.get('/testimonials', {
    where: after ? { id: { $gt: after } } : {},
    fields: 'id,senja_id',
    sort: 'id asc',
    limit: CLEANUP_PAGE_SIZE,
  })) as { results?: { id: string; senja_id: string }[] } | null;
  const records = result?.results ?? [];

  let removed = 0;
  for (const record of records) {
    if (!seenSenjaIds.has(record.senja_id)) {
      await swell.delete(`/testimonials/${record.id}`);
      removed++;
    }
  }
  const done = records.length < CLEANUP_PAGE_SIZE;
  return { removed, next_after: done ? null : records[records.length - 1].id };
}
