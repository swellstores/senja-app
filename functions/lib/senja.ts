import type { SenjaTestimonial } from './testimonials';

const SENJA_API_URL = 'https://api.senja.io/v1';

export class SenjaApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SenjaApiError';
    this.status = status;
  }
}

async function senjaRequest(apiKey: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${SENJA_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const detail = typeof body === 'object' && body ? body.message || body.error : body;
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check the API key in the app settings. Senja API access needs a Starter plan or higher.'
        : '';
    throw new SenjaApiError(`Senja API ${response.status}${detail ? `: ${detail}` : ''}.${hint}`, response.status);
  }
  return body;
}

/** One page of testimonials, newest first. Senja's `total` is the count on this page, not overall. */
export async function listTestimonials(
  apiKey: string,
  { page, limit }: { page: number; limit: number },
): Promise<{ testimonials: SenjaTestimonial[]; hasMore: boolean }> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit), sort: 'date', order: 'desc' });
  const body = await senjaRequest(apiKey, `/testimonials?${query}`);
  const testimonials: SenjaTestimonial[] = body?.testimonials ?? [];
  return { testimonials, hasMore: testimonials.length >= limit };
}

export interface InviteResult {
  sent: number;
  skipped: { email: string; reason: string }[];
}

/** Ask Senja to email a form invite to each recipient. */
export async function sendInvites(
  apiKey: string,
  formId: string,
  recipients: { email: string; name?: string }[],
): Promise<InviteResult> {
  const body = await senjaRequest(apiKey, '/invites', {
    method: 'POST',
    body: JSON.stringify({ form_id: formId, recipients }),
  });
  return { sent: body?.sent ?? 0, skipped: body?.skipped ?? [] };
}
