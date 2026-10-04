'use client'

import { useState, useEffect } from 'react'
import { X, Search, Zap, Save, Loader2, CheckCircle } from 'lucide-react'

export const ALL_CURRENCIES = [
  { code: 'AED', name: 'UAE Dirham',                      flag: '🇦🇪', symbol: 'د.إ'  },
  { code: 'AFN', name: 'Afghan Afghani',                   flag: '🇦🇫', symbol: '؋'    },
  { code: 'ALL', name: 'Albanian Lek',                     flag: '🇦🇱', symbol: 'L'    },
  { code: 'AMD', name: 'Armenian Dram',                    flag: '🇦🇲', symbol: '֏'    },
  { code: 'AOA', name: 'Angolan Kwanza',                   flag: '🇦🇴', symbol: 'Kz'   },
  { code: 'ARS', name: 'Argentine Peso',                   flag: '🇦🇷', symbol: '$'    },
  { code: 'AUD', name: 'Australian Dollar',                flag: '🇦🇺', symbol: 'A$'   },
  { code: 'AZN', name: 'Azerbaijani Manat',               flag: '🇦🇿', symbol: '₼'    },
  { code: 'BAM', name: 'Bosnia Convertible Mark',          flag: '🇧🇦', symbol: 'KM'   },
  { code: 'BBD', name: 'Barbadian Dollar',                 flag: '🇧🇧', symbol: '$'    },
  { code: 'BDT', name: 'Bangladeshi Taka',                 flag: '🇧🇩', symbol: '৳'    },
  { code: 'BGN', name: 'Bulgarian Lev',                    flag: '🇧🇬', symbol: 'лв'   },
  { code: 'BHD', name: 'Bahraini Dinar',                   flag: '🇧🇭', symbol: 'BD'   },
  { code: 'BND', name: 'Brunei Dollar',                    flag: '🇧🇳', symbol: 'B$'   },
  { code: 'BOB', name: 'Bolivian Boliviano',               flag: '🇧🇴', symbol: 'Bs.'  },
  { code: 'BRL', name: 'Brazilian Real',                   flag: '🇧🇷', symbol: 'R$'   },
  { code: 'BTN', name: 'Bhutanese Ngultrum',               flag: '🇧🇹', symbol: 'Nu'   },
  { code: 'BWP', name: 'Botswana Pula',                    flag: '🇧🇼', symbol: 'P'    },
  { code: 'BYN', name: 'Belarusian Ruble',                 flag: '🇧🇾', symbol: 'Br'   },
  { code: 'BZD', name: 'Belize Dollar',                    flag: '🇧🇿', symbol: 'BZ$'  },
  { code: 'CAD', name: 'Canadian Dollar',                  flag: '🇨🇦', symbol: 'CA$'  },
  { code: 'CHF', name: 'Swiss Franc',                      flag: '🇨🇭', symbol: 'CHF'  },
  { code: 'CLP', name: 'Chilean Peso',                     flag: '🇨🇱', symbol: '$'    },
  { code: 'CNY', name: 'Chinese Yuan',                     flag: '🇨🇳', symbol: '¥'    },
  { code: 'COP', name: 'Colombian Peso',                   flag: '🇨🇴', symbol: '$'    },
  { code: 'CRC', name: 'Costa Rican Colón',                flag: '🇨🇷', symbol: '₡'    },
  { code: 'CUP', name: 'Cuban Peso',                       flag: '🇨🇺', symbol: '$'    },
  { code: 'CZK', name: 'Czech Koruna',                     flag: '🇨🇿', symbol: 'Kč'   },
  { code: 'DKK', name: 'Danish Krone',                     flag: '🇩🇰', symbol: 'kr'   },
  { code: 'DOP', name: 'Dominican Peso',                   flag: '🇩🇴', symbol: 'RD$'  },
  { code: 'DZD', name: 'Algerian Dinar',                   flag: '🇩🇿', symbol: 'دج'   },
  { code: 'EGP', name: 'Egyptian Pound',                   flag: '🇪🇬', symbol: 'E£'   },
  { code: 'ETB', name: 'Ethiopian Birr',                   flag: '🇪🇹', symbol: 'Br'   },
  { code: 'EUR', name: 'Euro',                             flag: '🇪🇺', symbol: '€'    },
  { code: 'FJD', name: 'Fijian Dollar',                    flag: '🇫🇯', symbol: 'FJ$'  },
  { code: 'GBP', name: 'British Pound',                    flag: '🇬🇧', symbol: '£'    },
  { code: 'GEL', name: 'Georgian Lari',                    flag: '🇬🇪', symbol: '₾'    },
  { code: 'GHS', name: 'Ghanaian Cedi',                    flag: '🇬🇭', symbol: '₵'    },
  { code: 'GTQ', name: 'Guatemalan Quetzal',               flag: '🇬🇹', symbol: 'Q'    },
  { code: 'HKD', name: 'Hong Kong Dollar',                 flag: '🇭🇰', symbol: 'HK$'  },
  { code: 'HNL', name: 'Honduran Lempira',                 flag: '🇭🇳', symbol: 'L'    },
  { code: 'HTG', name: 'Haitian Gourde',                   flag: '🇭🇹', symbol: 'G'    },
  { code: 'HUF', name: 'Hungarian Forint',                 flag: '🇭🇺', symbol: 'Ft'   },
  { code: 'IDR', name: 'Indonesian Rupiah',                flag: '🇮🇩', symbol: 'Rp'   },
  { code: 'ILS', name: 'Israeli New Shekel',               flag: '🇮🇱', symbol: '₪'    },
  { code: 'IQD', name: 'Iraqi Dinar',                      flag: '🇮🇶', symbol: 'IQD'  },
  { code: 'IRR', name: 'Iranian Rial',                     flag: '🇮🇷', symbol: '﷼'    },
  { code: 'ISK', name: 'Icelandic Króna',                  flag: '🇮🇸', symbol: 'kr'   },
  { code: 'JMD', name: 'Jamaican Dollar',                  flag: '🇯🇲', symbol: 'J$'   },
  { code: 'JOD', name: 'Jordanian Dinar',                  flag: '🇯🇴', symbol: 'JD'   },
  { code: 'JPY', name: 'Japanese Yen',                     flag: '🇯🇵', symbol: '¥'    },
  { code: 'KES', name: 'Kenyan Shilling',                  flag: '🇰🇪', symbol: 'KSh'  },
  { code: 'KGS', name: 'Kyrgyzstani Som',                  flag: '🇰🇬', symbol: 'лв'   },
  { code: 'KHR', name: 'Cambodian Riel',                   flag: '🇰🇭', symbol: '៛'    },
  { code: 'KRW', name: 'South Korean Won',                 flag: '🇰🇷', symbol: '₩'    },
  { code: 'KWD', name: 'Kuwaiti Dinar',                    flag: '🇰🇼', symbol: 'KD'   },
  { code: 'KZT', name: 'Kazakhstani Tenge',                flag: '🇰🇿', symbol: '₸'    },
  { code: 'LAK', name: 'Lao Kip',                          flag: '🇱🇦', symbol: '₭'    },
  { code: 'LBP', name: 'Lebanese Pound',                   flag: '🇱🇧', symbol: 'L£'   },
  { code: 'LKR', name: 'Sri Lankan Rupee',                 flag: '🇱🇰', symbol: '₨'    },
  { code: 'LYD', name: 'Libyan Dinar',                     flag: '🇱🇾', symbol: 'LD'   },
  { code: 'MAD', name: 'Moroccan Dirham',                  flag: '🇲🇦', symbol: 'MAD'  },
  { code: 'MDL', name: 'Moldovan Leu',                     flag: '🇲🇩', symbol: 'L'    },
  { code: 'MKD', name: 'Macedonian Denar',                 flag: '🇲🇰', symbol: 'ден'  },
  { code: 'MMK', name: 'Myanmar Kyat',                     flag: '🇲🇲', symbol: 'K'    },
  { code: 'MNT', name: 'Mongolian Tögrög',                 flag: '🇲🇳', symbol: '₮'    },
  { code: 'MOP', name: 'Macanese Pataca',                  flag: '🇲🇴', symbol: 'MOP'  },
  { code: 'MUR', name: 'Mauritian Rupee',                  flag: '🇲🇺', symbol: '₨'    },
  { code: 'MVR', name: 'Maldivian Rufiyaa',                flag: '🇲🇻', symbol: 'Rf'   },
  { code: 'MWK', name: 'Malawian Kwacha',                  flag: '🇲🇼', symbol: 'MK'   },
  { code: 'MXN', name: 'Mexican Peso',                     flag: '🇲🇽', symbol: 'MX$'  },
  { code: 'MYR', name: 'Malaysian Ringgit',                flag: '🇲🇾', symbol: 'RM'   },
  { code: 'MZN', name: 'Mozambican Metical',               flag: '🇲🇿', symbol: 'MT'   },
  { code: 'NAD', name: 'Namibian Dollar',                  flag: '🇳🇦', symbol: 'N$'   },
  { code: 'NGN', name: 'Nigerian Naira',                   flag: '🇳🇬', symbol: '₦'    },
  { code: 'NIO', name: 'Nicaraguan Córdoba',               flag: '🇳🇮', symbol: 'C$'   },
  { code: 'NOK', name: 'Norwegian Krone',                  flag: '🇳🇴', symbol: 'kr'   },
  { code: 'NPR', name: 'Nepalese Rupee',                   flag: '🇳🇵', symbol: '₨'    },
  { code: 'NZD', name: 'New Zealand Dollar',               flag: '🇳🇿', symbol: 'NZ$'  },
  { code: 'OMR', name: 'Omani Rial',                       flag: '🇴🇲', symbol: 'OMR'  },
  { code: 'PAB', name: 'Panamanian Balboa',                flag: '🇵🇦', symbol: 'B/.'  },
  { code: 'PEN', name: 'Peruvian Sol',                     flag: '🇵🇪', symbol: 'S/.'  },
  { code: 'PGK', name: 'Papua New Guinean Kina',           flag: '🇵🇬', symbol: 'K'    },
  { code: 'PHP', name: 'Philippine Peso',                  flag: '🇵🇭', symbol: '₱'    },
  { code: 'PKR', name: 'Pakistani Rupee',                  flag: '🇵🇰', symbol: '₨'    },
  { code: 'PLN', name: 'Polish Złoty',                     flag: '🇵🇱', symbol: 'zł'   },
  { code: 'PYG', name: 'Paraguayan Guaraní',               flag: '🇵🇾', symbol: '₲'    },
  { code: 'QAR', name: 'Qatari Riyal',                     flag: '🇶🇦', symbol: 'QR'   },
  { code: 'RON', name: 'Romanian Leu',                     flag: '🇷🇴', symbol: 'lei'  },
  { code: 'RSD', name: 'Serbian Dinar',                    flag: '🇷🇸', symbol: 'din'  },
  { code: 'RUB', name: 'Russian Ruble',                    flag: '🇷🇺', symbol: '₽'    },
  { code: 'RWF', name: 'Rwandan Franc',                    flag: '🇷🇼', symbol: 'RF'   },
  { code: 'SAR', name: 'Saudi Riyal',                      flag: '🇸🇦', symbol: 'SR'   },
  { code: 'SEK', name: 'Swedish Krona',                    flag: '🇸🇪', symbol: 'kr'   },
  { code: 'SGD', name: 'Singapore Dollar',                 flag: '🇸🇬', symbol: 'S$'   },
  { code: 'SOS', name: 'Somali Shilling',                  flag: '🇸🇴', symbol: 'Sh'   },
  { code: 'SRD', name: 'Surinamese Dollar',                flag: '🇸🇷', symbol: '$'    },
  { code: 'SYP', name: 'Syrian Pound',                     flag: '🇸🇾', symbol: 'S£'   },
  { code: 'SZL', name: 'Swazi Lilangeni',                  flag: '🇸🇿', symbol: 'L'    },
  { code: 'THB', name: 'Thai Baht',                        flag: '🇹🇭', symbol: '฿'    },
  { code: 'TJS', name: 'Tajikistani Somoni',               flag: '🇹🇯', symbol: 'SM'   },
  { code: 'TMT', name: 'Turkmenistani Manat',              flag: '🇹🇲', symbol: 'T'    },
  { code: 'TND', name: 'Tunisian Dinar',                   flag: '🇹🇳', symbol: 'DT'   },
  { code: 'TRY', name: 'Turkish Lira',                     flag: '🇹🇷', symbol: '₺'    },
  { code: 'TTD', name: 'Trinidad & Tobago Dollar',         flag: '🇹🇹', symbol: 'TT$'  },
  { code: 'TWD', name: 'New Taiwan Dollar',                flag: '🇹🇼', symbol: 'NT$'  },
  { code: 'TZS', name: 'Tanzanian Shilling',               flag: '🇹🇿', symbol: 'Sh'   },
  { code: 'UAH', name: 'Ukrainian Hryvnia',                flag: '🇺🇦', symbol: '₴'    },
  { code: 'UGX', name: 'Ugandan Shilling',                 flag: '🇺🇬', symbol: 'Sh'   },
  { code: 'UYU', name: 'Uruguayan Peso',                   flag: '🇺🇾', symbol: '$U'   },
  { code: 'UZS', name: 'Uzbekistani Som',                  flag: '🇺🇿', symbol: 'лв'   },
  { code: 'VES', name: 'Venezuelan Bolívar',               flag: '🇻🇪', symbol: 'Bs.S' },
  { code: 'VND', name: 'Vietnamese Dong',                  flag: '🇻🇳', symbol: '₫'    },
  { code: 'XAF', name: 'Central African CFA Franc',        flag: '🌍', symbol: 'FCFA' },
  { code: 'XOF', name: 'West African CFA Franc',           flag: '🌍', symbol: 'CFA'  },
  { code: 'YER', name: 'Yemeni Rial',                      flag: '🇾🇪', symbol: '﷼'    },
  { code: 'ZAR', name: 'South African Rand',               flag: '🇿🇦', symbol: 'R'    },
  { code: 'ZMW', name: 'Zambian Kwacha',                   flag: '🇿🇲', symbol: 'ZK'   },
]

interface Props {
  packageLabel: string
  priceUsd: number
  localPrices: Record<string, number>
  onSave: (prices: Record<string, number>) => Promise<void>
  onClose: () => void
}

export default function LocalPricesModal({ packageLabel, priceUsd, localPrices, onSave, onClose }: Props) {
  const [prices, setPrices] = useState<Record<string, number>>({ ...localPrices })
  const [search, setSearch]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [rates, setRates]     = useState<Record<string, number>>({})
  const [loadingRates, setLoadingRates] = useState(false)

  useEffect(() => {
    setLoadingRates(true)
    fetch('https://open.er-api.com/v6/latest/USD')
      .then(r => r.json())
      .then(d => setRates(d.rates ?? {}))
      .catch(() => {})
      .finally(() => setLoadingRates(false))
  }, [])

  function autoFill() {
    const filled: Record<string, number> = {}
    ALL_CURRENCIES.forEach(c => {
      const rate = rates[c.code]
      if (rate) filled[c.code] = Math.round(priceUsd * rate)
    })
    setPrices(p => ({ ...p, ...filled }))
  }

  function set(code: string, val: string) {
    const n = parseFloat(val)
    if (val === '' || val === '0') {
      setPrices(p => { const next = { ...p }; delete next[code]; return next })
    } else if (!isNaN(n)) {
      setPrices(p => ({ ...p, [code]: n }))
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(prices)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }

  const q = search.toLowerCase()
  const filtered = q
    ? ALL_CURRENCIES.filter(c => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
    : ALL_CURRENCIES

  const setCount = Object.keys(prices).length

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-bold text-base">🌍 Country Prices — {packageLabel}</h2>
            <p className="text-slate-500 text-xs mt-0.5">
              Base: <span className="text-white">$  {priceUsd}</span> &nbsp;·&nbsp;
              <span className="text-green-400">{setCount} currencies set</span> &nbsp;·&nbsp;
              {loadingRates
                ? <span className="text-slate-500">Loading exchange rates…</span>
                : <span className="text-slate-400">Exchange rates ready for auto-fill</span>
              }
            </p>
          </div>
          <button
            onClick={autoFill}
            disabled={loadingRates || Object.keys(rates).length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 disabled:opacity-40 text-yellow-300 border border-yellow-500/30 rounded-lg text-xs font-medium transition-colors"
          >
            {loadingRates ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Auto-fill from $
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <CheckCircle size={12} /> : <Save size={12} />}
            {saved ? 'Saved!' : 'Save All'}
          </button>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <Search size={13} className="text-slate-500 shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search currency or country…"
              className="bg-transparent text-white text-sm flex-1 outline-none placeholder:text-slate-600"
              autoFocus
            />
            {search && <button onClick={() => setSearch('')} className="text-slate-500 hover:text-white text-xs">✕</button>}
          </div>
          <p className="text-slate-600 text-xs mt-1.5">Showing {filtered.length} of {ALL_CURRENCIES.length} currencies · Leave blank to hide that currency in app</p>
        </div>

        {/* Grid */}
        <div className="overflow-y-auto flex-1 p-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {filtered.map(c => {
              const val = prices[c.code]
              const isSet = val !== undefined && val > 0
              return (
                <div key={c.code} className={`flex items-center gap-2.5 rounded-xl px-3 py-2 border transition-colors ${
                  isSet ? 'bg-slate-800 border-slate-600' : 'bg-slate-800/40 border-slate-700/50'
                }`}>
                  <span className="text-xl shrink-0 leading-none">{c.flag}</span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-bold ${isSet ? 'text-white' : 'text-slate-400'}`}>{c.code}</div>
                    <div className="text-slate-500 text-[10px] truncate">{c.name}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-slate-500 text-[10px]">{c.symbol}</span>
                    <input
                      type="number"
                      min={0}
                      value={val ?? ''}
                      onChange={e => set(c.code, e.target.value)}
                      placeholder="—"
                      className={`w-20 rounded-lg px-2 py-1 text-sm text-right outline-none transition-colors ${
                        isSet
                          ? 'bg-slate-700 border border-pink-500/40 text-white focus:border-pink-500'
                          : 'bg-slate-700/50 border border-slate-600/50 text-slate-400 focus:border-pink-500 focus:text-white focus:bg-slate-700'
                      }`}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 shrink-0 flex items-center justify-between">
          <p className="text-slate-600 text-xs">{setCount} of {ALL_CURRENCIES.length} currencies have a price set</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-5 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : saved ? <CheckCircle size={11} /> : <Save size={11} />}
              {saved ? 'Saved!' : 'Save All Prices'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
