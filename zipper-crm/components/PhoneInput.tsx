'use client'

/**
 * A phone number with a country code, everywhere the CRM asks for one.
 *
 * The forms used to take one free-text box with "+91 9876543210" as the
 * placeholder, so anybody outside India had to know to type their own code,
 * and most did not. This splits it: a country picker (the same list as the
 * Android app) and the national digits. `onChange` always receives E.164 —
 * `+<code><digits>` — or '' when nothing has been typed.
 */
import { useEffect, useState } from 'react'
import { COUNTRY_CODES, DEFAULT_DIAL_CODE, joinPhone, splitPhone } from '@/lib/countryCodes'

export default function PhoneInput({
  value,
  onChange,
  className = '',
  placeholder = 'Mobile number',
  disabled = false,
  id,
}: {
  value: string
  onChange: (e164: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
}) {
  const initial = splitPhone(value)
  const [dial, setDial] = useState(initial.dialCode)
  const [digits, setDigits] = useState(initial.digits)

  // Follow a value set from outside (a form reset, a prefill).
  useEffect(() => {
    if (joinPhone(dial, digits) !== (value || '').replace(/[\s-]/g, '')) {
      const next = splitPhone(value)
      setDial(next.dialCode)
      setDigits(next.digits)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const max = COUNTRY_CODES.find((c) => c.dialCode === dial)?.maxDigits ?? 15

  return (
    <div className="flex gap-2">
      <select
        aria-label="Country code"
        disabled={disabled}
        value={dial}
        onChange={(e) => {
          const d = e.target.value || DEFAULT_DIAL_CODE
          setDial(d)
          onChange(joinPhone(d, digits))
        }}
        className={`${className} !w-28 shrink-0`}
      >
        {COUNTRY_CODES.map((c) => (
          <option key={`${c.name}${c.dialCode}`} value={c.dialCode}>
            {c.flag} {c.dialCode} {c.name}
          </option>
        ))}
      </select>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        disabled={disabled}
        className={`${className} flex-1 min-w-0`}
        placeholder={placeholder}
        value={digits}
        onChange={(e) => {
          const d = e.target.value.replace(/\D/g, '').slice(0, max)
          setDigits(d)
          onChange(joinPhone(dial, d))
        }}
      />
    </div>
  )
}
