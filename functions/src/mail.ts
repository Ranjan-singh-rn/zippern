/**
 * Transactional mail from Functions — the one-time code for email binding.
 *
 * Same provider and sender as `sendMail` in index.ts (SendGrid, `SG_MAIL_KEY`,
 * the existing "Zipper Team" address), so nothing about production mail
 * configuration changes. Two differences, both because the reader of a code
 * email is waiting for it:
 *
 *   * A missing key or a refused send THROWS. `sendMail` logs and returns,
 *     which is fine for a courtesy email and wrong here: the caller has to be
 *     able to say "we could not send the code" instead of "check your inbox"
 *     for a message that never left.
 *   * Only the recipient's DOMAIN is ever logged, never the address, the
 *     subject or the body — the body carries the code.
 *
 * The transport is replaceable so the callables can be run in tests without a
 * network.
 */
import * as functions from 'firebase-functions/v1'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sgMail = require('@sendgrid/mail')

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export type MailTransport = (message: MailMessage) => Promise<void>

/** The sender every Functions email already uses (index.ts `sendMail`). */
export const MAIL_FROM = { email: '314zipper@gmail.com', name: 'Zipper Team' }

/** The mail could not be handed to the provider. Safe to show as "try again". */
export class MailUnavailable extends Error {}

const sendGrid: MailTransport = async (m) => {
  const apiKey = process.env.SG_MAIL_KEY || ''
  if (!apiKey) throw new MailUnavailable('mail is not configured')
  sgMail.setApiKey(apiKey)
  await sgMail.send({ to: m.to, from: MAIL_FROM, subject: m.subject, html: m.html, text: m.text })
}

let transport: MailTransport = sendGrid

/** Tests only: route mail somewhere observable. `null` restores SendGrid. */
export function setMailTransportForTests(next: MailTransport | null): void {
  transport = next ?? sendGrid
}

export function mailDomain(to: string): string {
  return String(to ?? '').split('@')[1] ?? ''
}

export async function sendTransactionalMail(message: MailMessage): Promise<void> {
  const toDomain = mailDomain(message.to)
  try {
    await transport(message)
    functions.logger.info('transactional mail sent', { toDomain })
  } catch (err) {
    const notConfigured = err instanceof MailUnavailable
    functions.logger.error('transactional mail failed', {
      toDomain,
      reason: notConfigured ? 'not_configured' : String((err as { code?: unknown })?.code ?? 'provider_error'),
    })
    throw notConfigured ? err : new MailUnavailable('send failed')
  }
}
