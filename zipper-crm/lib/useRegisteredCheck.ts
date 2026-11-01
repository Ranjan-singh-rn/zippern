'use client'

/**
 * Flags an email / phone that is already registered for a partner role, as
 * the applicant types it — not after four pages and a Submit.
 *
 * Debounced, and best-effort by design: a failed check shows nothing and the
 * submit-time checks (the duplicate query, Firebase Auth, the API's role
 * rules) still stand. It only ever ADDS a warning; it never clears one the
 * submit path raised.
 */
import { useEffect, useState } from 'react'
import api from '@/lib/api'

const ROLE_NOUN: Record<'agency' | 'seller', string> = { agency: 'an Agency', seller: 'a Coin Seller' }

export function registeredMessage(field: 'email' | 'phone', role: 'agency' | 'seller' | null): string {
  if (!role) return ''
  return `This ${field === 'email' ? 'email address' : 'phone number'} is already registered as ` +
    `${ROLE_NOUN[role]}. Sign in at /login instead, or use a different ${field === 'email' ? 'address' : 'number'}.`
}

export function useRegisteredCheck(email: string, phone: string) {
  const [taken, setTaken] = useState<{ email: string; phone: string }>({ email: '', phone: '' })

  useEffect(() => {
    const e = email.trim().toLowerCase()
    const p = phone.trim()
    const emailOk = /^\S+@\S+\.\S+$/.test(e)
    const phoneOk = p.replace(/\D/g, '').length >= 7
    if (!emailOk && !phoneOk) { setTaken({ email: '', phone: '' }); return }
    let live = true
    const timer = setTimeout(() => {
      api.partnerOps.registrationAvailability(emailOk ? e : '', phoneOk ? p : '')
        .then((r) => {
          if (!live) return
          setTaken({
            email: emailOk ? registeredMessage('email', r.email) : '',
            phone: phoneOk ? registeredMessage('phone', r.phone) : '',
          })
        })
        .catch(() => { if (live) setTaken({ email: '', phone: '' }) })
    }, 500)
    return () => { live = false; clearTimeout(timer) }
  }, [email, phone])

  return taken
}
