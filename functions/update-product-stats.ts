import { refreshProductStats } from './lib/product-stats';

export const config: SwellConfig = {
  description: "Keep each product's testimonial count and average rating current",
  model: {
    events: ['testimonial.created', 'testimonial.updated', 'testimonial.deleted'],
  },
};

const STAT_FIELDS = ['product_id', 'previous_product_id', 'approved', 'rating'];

export default async function (req: SwellRequest) {
  const { data } = req;
  const event = data.$event;

  // Updates to other fields (text, avatar, ...) don't change the stats.
  if (event?.type?.endsWith('.updated')) {
    const changed = Object.keys(event.data ?? {});
    if (!changed.some((field) => STAT_FIELDS.includes(field))) {
      return { skipped: 'no_stat_change' };
    }
  }

  // On deletes the record is gone, so its fields may only be in the event snapshot.
  const snapshot = event?.data ?? {};
  const saved = await refreshProductStats(req, [
    data.product_id,
    data.previous_product_id,
    snapshot.product_id,
    snapshot.previous_product_id,
  ]);
  return { products: saved };
}
