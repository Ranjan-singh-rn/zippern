/**
 * Country dialling codes, mirrored from the Android app's
 * `util/CountryCodes.kt` so the CRM and the app offer the same list.
 * `maxDigits` is the longest national number after the code.
 */
export interface CountryCode { name: string; flag: string; dialCode: string; maxDigits: number }

export const COUNTRY_CODES: CountryCode[] = [
  { name: 'Afghanistan', flag: '🇦🇫', dialCode: '+93', maxDigits: 9 },
  { name: 'Albania', flag: '🇦🇱', dialCode: '+355', maxDigits: 9 },
  { name: 'Algeria', flag: '🇩🇿', dialCode: '+213', maxDigits: 9 },
  { name: 'Argentina', flag: '🇦🇷', dialCode: '+54', maxDigits: 10 },
  { name: 'Armenia', flag: '🇦🇲', dialCode: '+374', maxDigits: 8 },
  { name: 'Australia', flag: '🇦🇺', dialCode: '+61', maxDigits: 9 },
  { name: 'Austria', flag: '🇦🇹', dialCode: '+43', maxDigits: 10 },
  { name: 'Azerbaijan', flag: '🇦🇿', dialCode: '+994', maxDigits: 9 },
  { name: 'Bahrain', flag: '🇧🇭', dialCode: '+973', maxDigits: 8 },
  { name: 'Bangladesh', flag: '🇧🇩', dialCode: '+880', maxDigits: 10 },
  { name: 'Belarus', flag: '🇧🇾', dialCode: '+375', maxDigits: 9 },
  { name: 'Belgium', flag: '🇧🇪', dialCode: '+32', maxDigits: 9 },
  { name: 'Bolivia', flag: '🇧🇴', dialCode: '+591', maxDigits: 8 },
  { name: 'Bosnia & Herzegovina', flag: '🇧🇦', dialCode: '+387', maxDigits: 8 },
  { name: 'Brazil', flag: '🇧🇷', dialCode: '+55', maxDigits: 11 },
  { name: 'Bulgaria', flag: '🇧🇬', dialCode: '+359', maxDigits: 9 },
  { name: 'Cambodia', flag: '🇰🇭', dialCode: '+855', maxDigits: 9 },
  { name: 'Cameroon', flag: '🇨🇲', dialCode: '+237', maxDigits: 9 },
  { name: 'Canada', flag: '🇨🇦', dialCode: '+1', maxDigits: 10 },
  { name: 'Chile', flag: '🇨🇱', dialCode: '+56', maxDigits: 9 },
  { name: 'China', flag: '🇨🇳', dialCode: '+86', maxDigits: 11 },
  { name: 'Colombia', flag: '🇨🇴', dialCode: '+57', maxDigits: 10 },
  { name: 'Croatia', flag: '🇭🇷', dialCode: '+385', maxDigits: 9 },
  { name: 'Cyprus', flag: '🇨🇾', dialCode: '+357', maxDigits: 8 },
  { name: 'Czech Republic', flag: '🇨🇿', dialCode: '+420', maxDigits: 9 },
  { name: 'Denmark', flag: '🇩🇰', dialCode: '+45', maxDigits: 8 },
  { name: 'Ecuador', flag: '🇪🇨', dialCode: '+593', maxDigits: 9 },
  { name: 'Egypt', flag: '🇪🇬', dialCode: '+20', maxDigits: 10 },
  { name: 'Estonia', flag: '🇪🇪', dialCode: '+372', maxDigits: 8 },
  { name: 'Ethiopia', flag: '🇪🇹', dialCode: '+251', maxDigits: 9 },
  { name: 'Finland', flag: '🇫🇮', dialCode: '+358', maxDigits: 10 },
  { name: 'France', flag: '🇫🇷', dialCode: '+33', maxDigits: 9 },
  { name: 'Georgia', flag: '🇬🇪', dialCode: '+995', maxDigits: 9 },
  { name: 'Germany', flag: '🇩🇪', dialCode: '+49', maxDigits: 11 },
  { name: 'Ghana', flag: '🇬🇭', dialCode: '+233', maxDigits: 9 },
  { name: 'Greece', flag: '🇬🇷', dialCode: '+30', maxDigits: 10 },
  { name: 'Guatemala', flag: '🇬🇹', dialCode: '+502', maxDigits: 8 },
  { name: 'Hong Kong', flag: '🇭🇰', dialCode: '+852', maxDigits: 8 },
  { name: 'Hungary', flag: '🇭🇺', dialCode: '+36', maxDigits: 9 },
  { name: 'India', flag: '🇮🇳', dialCode: '+91', maxDigits: 10 },
  { name: 'Indonesia', flag: '🇮🇩', dialCode: '+62', maxDigits: 12 },
  { name: 'Iran', flag: '🇮🇷', dialCode: '+98', maxDigits: 10 },
  { name: 'Iraq', flag: '🇮🇶', dialCode: '+964', maxDigits: 10 },
  { name: 'Ireland', flag: '🇮🇪', dialCode: '+353', maxDigits: 9 },
  { name: 'Israel', flag: '🇮🇱', dialCode: '+972', maxDigits: 9 },
  { name: 'Italy', flag: '🇮🇹', dialCode: '+39', maxDigits: 10 },
  { name: 'Jamaica', flag: '🇯🇲', dialCode: '+1', maxDigits: 10 },
  { name: 'Japan', flag: '🇯🇵', dialCode: '+81', maxDigits: 10 },
  { name: 'Jordan', flag: '🇯🇴', dialCode: '+962', maxDigits: 9 },
  { name: 'Kazakhstan', flag: '🇰🇿', dialCode: '+7', maxDigits: 10 },
  { name: 'Kenya', flag: '🇰🇪', dialCode: '+254', maxDigits: 9 },
  { name: 'Kuwait', flag: '🇰🇼', dialCode: '+965', maxDigits: 8 },
  { name: 'Kyrgyzstan', flag: '🇰🇬', dialCode: '+996', maxDigits: 9 },
  { name: 'Laos', flag: '🇱🇦', dialCode: '+856', maxDigits: 9 },
  { name: 'Latvia', flag: '🇱🇻', dialCode: '+371', maxDigits: 8 },
  { name: 'Lebanon', flag: '🇱🇧', dialCode: '+961', maxDigits: 8 },
  { name: 'Libya', flag: '🇱🇾', dialCode: '+218', maxDigits: 9 },
  { name: 'Lithuania', flag: '🇱🇹', dialCode: '+370', maxDigits: 8 },
  { name: 'Luxembourg', flag: '🇱🇺', dialCode: '+352', maxDigits: 9 },
  { name: 'Malaysia', flag: '🇲🇾', dialCode: '+60', maxDigits: 10 },
  { name: 'Maldives', flag: '🇲🇻', dialCode: '+960', maxDigits: 7 },
  { name: 'Mexico', flag: '🇲🇽', dialCode: '+52', maxDigits: 10 },
  { name: 'Moldova', flag: '🇲🇩', dialCode: '+373', maxDigits: 8 },
  { name: 'Mongolia', flag: '🇲🇳', dialCode: '+976', maxDigits: 8 },
  { name: 'Morocco', flag: '🇲🇦', dialCode: '+212', maxDigits: 9 },
  { name: 'Mozambique', flag: '🇲🇿', dialCode: '+258', maxDigits: 9 },
  { name: 'Myanmar', flag: '🇲🇲', dialCode: '+95', maxDigits: 9 },
  { name: 'Nepal', flag: '🇳🇵', dialCode: '+977', maxDigits: 10 },
  { name: 'Netherlands', flag: '🇳🇱', dialCode: '+31', maxDigits: 9 },
  { name: 'New Zealand', flag: '🇳🇿', dialCode: '+64', maxDigits: 9 },
  { name: 'Nigeria', flag: '🇳🇬', dialCode: '+234', maxDigits: 10 },
  { name: 'Norway', flag: '🇳🇴', dialCode: '+47', maxDigits: 8 },
  { name: 'Oman', flag: '🇴🇲', dialCode: '+968', maxDigits: 8 },
  { name: 'Pakistan', flag: '🇵🇰', dialCode: '+92', maxDigits: 10 },
  { name: 'Palestine', flag: '🇵🇸', dialCode: '+970', maxDigits: 9 },
  { name: 'Panama', flag: '🇵🇦', dialCode: '+507', maxDigits: 8 },
  { name: 'Paraguay', flag: '🇵🇾', dialCode: '+595', maxDigits: 9 },
  { name: 'Peru', flag: '🇵🇪', dialCode: '+51', maxDigits: 9 },
  { name: 'Philippines', flag: '🇵🇭', dialCode: '+63', maxDigits: 10 },
  { name: 'Poland', flag: '🇵🇱', dialCode: '+48', maxDigits: 9 },
  { name: 'Portugal', flag: '🇵🇹', dialCode: '+351', maxDigits: 9 },
  { name: 'Qatar', flag: '🇶🇦', dialCode: '+974', maxDigits: 8 },
  { name: 'Romania', flag: '🇷🇴', dialCode: '+40', maxDigits: 9 },
  { name: 'Russia', flag: '🇷🇺', dialCode: '+7', maxDigits: 10 },
  { name: 'Saudi Arabia', flag: '🇸🇦', dialCode: '+966', maxDigits: 9 },
  { name: 'Serbia', flag: '🇷🇸', dialCode: '+381', maxDigits: 9 },
  { name: 'Singapore', flag: '🇸🇬', dialCode: '+65', maxDigits: 8 },
  { name: 'Slovakia', flag: '🇸🇰', dialCode: '+421', maxDigits: 9 },
  { name: 'Slovenia', flag: '🇸🇮', dialCode: '+386', maxDigits: 8 },
  { name: 'South Africa', flag: '🇿🇦', dialCode: '+27', maxDigits: 9 },
  { name: 'South Korea', flag: '🇰🇷', dialCode: '+82', maxDigits: 10 },
  { name: 'Spain', flag: '🇪🇸', dialCode: '+34', maxDigits: 9 },
  { name: 'Sri Lanka', flag: '🇱🇰', dialCode: '+94', maxDigits: 9 },
  { name: 'Sudan', flag: '🇸🇩', dialCode: '+249', maxDigits: 9 },
  { name: 'Sweden', flag: '🇸🇪', dialCode: '+46', maxDigits: 9 },
  { name: 'Switzerland', flag: '🇨🇭', dialCode: '+41', maxDigits: 9 },
  { name: 'Syria', flag: '🇸🇾', dialCode: '+963', maxDigits: 9 },
  { name: 'Taiwan', flag: '🇹🇼', dialCode: '+886', maxDigits: 9 },
  { name: 'Tajikistan', flag: '🇹🇯', dialCode: '+992', maxDigits: 9 },
  { name: 'Tanzania', flag: '🇹🇿', dialCode: '+255', maxDigits: 9 },
  { name: 'Thailand', flag: '🇹🇭', dialCode: '+66', maxDigits: 9 },
  { name: 'Tunisia', flag: '🇹🇳', dialCode: '+216', maxDigits: 8 },
  { name: 'Turkey', flag: '🇹🇷', dialCode: '+90', maxDigits: 10 },
  { name: 'Turkmenistan', flag: '🇹🇲', dialCode: '+993', maxDigits: 8 },
  { name: 'Uganda', flag: '🇺🇬', dialCode: '+256', maxDigits: 9 },
  { name: 'Ukraine', flag: '🇺🇦', dialCode: '+380', maxDigits: 9 },
  { name: 'United Arab Emirates', flag: '🇦🇪', dialCode: '+971', maxDigits: 9 },
  { name: 'United Kingdom', flag: '🇬🇧', dialCode: '+44', maxDigits: 10 },
  { name: 'United States', flag: '🇺🇸', dialCode: '+1', maxDigits: 10 },
  { name: 'Uruguay', flag: '🇺🇾', dialCode: '+598', maxDigits: 8 },
  { name: 'Uzbekistan', flag: '🇺🇿', dialCode: '+998', maxDigits: 9 },
  { name: 'Venezuela', flag: '🇻🇪', dialCode: '+58', maxDigits: 10 },
  { name: 'Vietnam', flag: '🇻🇳', dialCode: '+84', maxDigits: 9 },
  { name: 'Yemen', flag: '🇾🇪', dialCode: '+967', maxDigits: 9 },
  { name: 'Zimbabwe', flag: '🇿🇼', dialCode: '+263', maxDigits: 9 },
]

/** The default — the business is in India. */
export const DEFAULT_DIAL_CODE = '+91'

/**
 * Split a stored phone string into a dial code and national digits. Takes the
 * LONGEST matching code (+1 vs +1x…). A bare national number keeps the default.
 */
export function splitPhone(value: string): { dialCode: string; digits: string } {
  const v = (value || '').replace(/[\s-]/g, '')
  if (v.startsWith('+')) {
    const match = [...COUNTRY_CODES]
      .sort((a, b) => b.dialCode.length - a.dialCode.length)
      .find((c) => v.startsWith(c.dialCode))
    if (match) return { dialCode: match.dialCode, digits: v.slice(match.dialCode.length).replace(/\D/g, '') }
  }
  return { dialCode: DEFAULT_DIAL_CODE, digits: v.replace(/\D/g, '').replace(/^0+/, '') }
}

/** E.164 from a dial code and national digits; '' when there are no digits. */
export function joinPhone(dialCode: string, digits: string): string {
  const d = (digits || '').replace(/\D/g, '').replace(/^0+/, '')
  return d ? `${dialCode}${d}` : ''
}
