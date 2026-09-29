import { readInviteSettings, scheduledDate } from './lib/invites';

export const config: SwellConfig = {
  description: 'Schedule a Senja review invite when an order is delivered',
  model: {
    events: ['order.delivered'],
  },
};

interface Account {
  email?: string;
  name?: string;
  first_name?: string;
  email_optin?: boolean;
}

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = readInviteSettings(await swell.settings());

  if (!settings.enabled) {
    return { skipped: 'invites_off' };
  }
  if (!settings.formId || !settings.apiKey) {
    return { skipped: 'not_configured' };
  }

  const orderId: string | undefined = data.id;
  const accountId: string | undefined = data.account_id;
  if (!orderId || !accountId) {
    return { skipped: 'no_customer' };
  }

  const account = (await swell.get(`/accounts/${accountId}`, {
    fields: 'email,name,first_name,email_optin',
  })) as Account | null;
  const email = account?.email;
  if (!email) {
    return { skipped: 'no_email' };
  }
  if (settings.onlyOptedIn && account?.email_optin !== true) {
    return { skipped: 'not_opted_in' };
  }

  const existing = (await swell.get('/invites', { where: { order_id: orderId }, limit: 1 })) as {
    results?: { id: string }[];
  } | null;
  if (existing?.results?.length) {
    return { skipped: 'already_scheduled', id: existing.results[0].id };
  }

  const invite = (await swell.post('/invites', {
    order_id: orderId,
    email,
    name: account?.name || data.billing?.name || account?.first_name || null,
    form_id: settings.formId,
    status: 'scheduled',
    date_scheduled: scheduledDate(Date.now(), settings.delayDays),
  })) as { id: string; date_scheduled: string };

  return { scheduled: invite.id, date_scheduled: invite.date_scheduled };
}
