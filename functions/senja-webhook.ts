import { verifySenjaSignature } from './lib/signature';
import { deleteTestimonial, upsertTestimonial, type SenjaTestimonial } from './lib/testimonials';

export const config: SwellConfig = {
  description: 'Receive testimonial events from Senja',
  route: {
    public: true,
    methods: ['post'],
    headers: ['x-senja-signature', 'content-type'],
  },
};

interface SenjaWebhookEvent {
  type?: string;
  data?: {
    new?: SenjaTestimonial;
    old?: SenjaTestimonial;
  };
}

export async function post(req: SwellRequest) {
  const { swell } = req;
  const settings = await swell.settings();
  const secret: string | undefined = settings?.connection?.webhook_secret;

  if (!secret) {
    throw new SwellError('Senja webhook secret is not set in the app settings', { status: 503 });
  }

  const valid = await verifySenjaSignature(secret, req.rawBody, req.headers.get('x-senja-signature'));
  if (!valid) {
    throw new SwellError('Invalid Senja signature', { status: 401 });
  }

  const event = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as SenjaWebhookEvent;

  switch (event.type) {
    case 'testimonial_created':
    case 'testimonial_updated': {
      const testimonial = event.data?.new;
      if (!testimonial?.id) {
        throw new SwellError('Missing testimonial in event', { status: 400 });
      }
      return { ok: true, ...(await upsertTestimonial(swell, testimonial)) };
    }
    case 'testimonial_deleted': {
      const senjaId = event.data?.old?.id;
      if (!senjaId) {
        throw new SwellError('Missing testimonial in event', { status: 400 });
      }
      return { ok: true, ...(await deleteTestimonial(swell, senjaId)) };
    }
    default:
      // Acknowledge events the app doesn't handle so Senja doesn't retry them.
      return { ok: true, action: 'ignored', type: event.type ?? null };
  }
}
