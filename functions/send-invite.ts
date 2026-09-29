import { readInviteSettings, type InviteRecord } from './lib/invites';
import { SenjaApiError, sendInvites } from './lib/senja';

export const config: SwellConfig = {
  description: 'Send a scheduled Senja review invite',
  model: {
    events: ['invite.created', 'invite.updated'],
    conditions: { status: 'scheduled' },
    schedule: { formula: 'date_scheduled' },
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const inviteId: string | undefined = data.id;
  if (!inviteId) {
    return { skipped: 'no_invite' };
  }

  // Re-read the record: it may have changed since the event was scheduled.
  const invite = (await swell.get(`/invites/${inviteId}`)) as InviteRecord | null;
  if (!invite || invite.status !== 'scheduled') {
    return { skipped: 'not_scheduled' };
  }
  if (new Date(invite.date_scheduled).getTime() > Date.now()) {
    return { skipped: 'not_due' };
  }

  const settings = readInviteSettings(await swell.settings());
  const finish = (values: Partial<InviteRecord> & { error?: string | null; date_sent?: string }) =>
    swell.put(`/invites/${inviteId}`, values);

  if (!settings.enabled) {
    await finish({ status: 'skipped', error: 'Review invites were turned off before this invite was due' });
    return { status: 'skipped' };
  }
  const formId = invite.form_id || settings.formId;
  if (!settings.apiKey || !formId) {
    await finish({ status: 'failed', error: 'Add the Senja API key and form ID in the app settings' });
    return { status: 'failed' };
  }

  try {
    const result = await sendInvites(settings.apiKey, formId, [
      { email: invite.email, ...(invite.name ? { name: invite.name } : {}) },
    ]);
    if (result.sent > 0) {
      await finish({ status: 'sent', date_sent: new Date(Date.now()).toISOString(), error: null });
      return { status: 'sent' };
    }
    const reason = result.skipped[0]?.reason || 'Senja did not send the invite';
    await finish({ status: 'skipped', error: reason });
    return { status: 'skipped', reason };
  } catch (error) {
    if (error instanceof SenjaApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
      // A request problem (bad key, unknown form) won't succeed on retry.
      await finish({ status: 'failed', error: error.message });
      return { status: 'failed', error: error.message };
    }
    // Rate limits and outages: let the platform retry the event.
    throw error;
  }
}
