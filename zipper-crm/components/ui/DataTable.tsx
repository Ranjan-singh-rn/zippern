'use client'

/**
 * One table for every list in the CRM.
 *
 * Search, filter, sort, paginate and export, behaving identically everywhere.
 * Built because the CRM had a dozen bespoke tables: some searched, some did
 * not, none exported, and several filtered client-side over a partial fetch —
 * which silently returns wrong answers once the data outgrows the page.
 *
 * Two modes:
 *   client  — rows are already fully loaded; search and sort locally
 *   server  — the caller owns fetching; this reports intent via callbacks
 *
 * Use server mode whenever the data can outgrow one page. Searching a partial
 * set looks like it works and quietly lies.
 */

import { useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download,
  Filter, Search, X,
} from 'lucide-react'
import { Empty, ErrorState, Loading } from './States'

export interface Column<T> {
  key: string
  header: string
  /** Cell contents. Omit to render `row[key]`. */
  render?: (row: T) => React.ReactNode
  /** Value used for sorting and CSV export. Omit to use `row[key]`. */
  value?: (row: T) => string | number | null | undefined
  sortable?: boolean
  align?: 'left' | 'right'
  /** Hide below the `sm` breakpoint, for narrow screens. */
  hideOnMobile?: boolean
}

export interface FilterOption {
  key: string
  label: string
  options: { value: string; label: string; count?: number }[]
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string

  loading?: boolean
  error?: string
  onRetry?: () => void

  /** Placeholder implies what is actually searched — be specific. */
  searchPlaceholder?: string
  /** Server mode: called as the user types (already debounced by the caller). */
  onSearch?: (term: string) => void
  /** Client mode: which columns the local search looks at. */
  searchKeys?: string[]

  filters?: FilterOption[]
  activeFilters?: Record<string, string>
  onFilterChange?: (key: string, value: string) => void

  onRowClick?: (row: T) => void

  /** Enables the export button. Filename gets a date suffix. */
  exportName?: string
  onExport?: () => void

  /** Server pagination. Omit for client-side paging. */
  page?: number
  hasMore?: boolean
  onPageChange?: (page: number) => void
  pageSize?: number

  emptyTitle?: string
  emptyHint?: string
  /** Shown when the caller knows results were capped — honesty over silence. */
  truncatedAt?: number
}

export function DataTable<T>({
  rows, columns, rowKey,
  loading, error, onRetry,
  searchPlaceholder = 'Search…', onSearch, searchKeys,
  filters, activeFilters = {}, onFilterChange,
  onRowClick,
  exportName, onExport,
  page, hasMore, onPageChange, pageSize = 25,
  emptyTitle, emptyHint, truncatedAt,
}: Props<T>) {
  const [term, setTerm] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [localPage, setLocalPage] = useState(0)

  const serverMode = !!onSearch || !!onPageChange

  function cellValue(row: T, col: Column<T>): string | number | null | undefined {
    if (col.value) return col.value(row)
    return (row as Record<string, unknown>)[col.key] as string | number | undefined
  }

  const searched = useMemo(() => {
    if (serverMode || !term.trim()) return rows
    const q = term.toLowerCase()
    const keys = searchKeys ?? columns.map((c) => c.key)
    return rows.filter((row) =>
      keys.some((k) => {
        const col = columns.find((c) => c.key === k)
        const v = col ? cellValue(row, col) : (row as Record<string, unknown>)[k]
        return String(v ?? '').toLowerCase().includes(q)
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, term, serverMode, searchKeys, columns])

  const sorted = useMemo(() => {
    if (!sortKey) return searched
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return searched
    return [...searched].sort((a, b) => {
      const av = cellValue(a, col)
      const bv = cellValue(b, col)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, sortKey, sortDir, columns])

  const paged = useMemo(() => {
    if (serverMode) return sorted
    const start = localPage * pageSize
    return sorted.slice(start, start + pageSize)
  }, [sorted, localPage, pageSize, serverMode])

  const currentPage = serverMode ? (page ?? 0) : localPage
  const canPrev = currentPage > 0
  const canNext = serverMode ? !!hasMore : (localPage + 1) * pageSize < sorted.length

  function goTo(next: number) {
    if (serverMode) onPageChange?.(next)
    else setLocalPage(next)
  }

  function toggleSort(col: Column<T>) {
    if (col.sortable === false) return
    if (sortKey === col.key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(col.key); setSortDir('asc') }
  }

  function exportCsv() {
    if (onExport) return onExport()
    const header = columns.map((c) => c.header)
    const body = sorted.map((row) => columns.map((c) => cellValue(row, c)))
    downloadCsv([header, ...body], exportName ?? 'export')
  }

  const activeFilterCount = Object.values(activeFilters).filter((v) => v && v !== 'all').length

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-col lg:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value)
              setLocalPage(0)
              onSearch?.(e.target.value)
            }}
            placeholder={searchPlaceholder}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {term && (
            <button
              onClick={() => { setTerm(''); onSearch?.('') }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {filters?.map((f) => (
          <select
            key={f.key}
            value={activeFilters[f.key] ?? 'all'}
            onChange={(e) => { onFilterChange?.(f.key, e.target.value); setLocalPage(0) }}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="all">{f.label}: all</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}{o.count != null ? ` (${o.count})` : ''}
              </option>
            ))}
          </select>
        ))}

        {(exportName || onExport) && (
          <button
            onClick={exportCsv}
            disabled={sorted.length === 0}
            title="Download as CSV"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 rounded-lg px-4 py-2.5 text-sm transition-colors shrink-0"
          >
            <Download size={14} /> Export
          </button>
        )}
      </div>

      {activeFilterCount > 0 && (
        <div className="flex items-center gap-2 mb-3 text-xs text-slate-500">
          <Filter size={12} />
          {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} applied
          <button
            onClick={() => filters?.forEach((f) => onFilterChange?.(f.key, 'all'))}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            clear
          </button>
        </div>
      )}

      {/* Body */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : paged.length === 0 ? (
          <Empty
            title={emptyTitle ?? (term || activeFilterCount ? 'Nothing matches' : 'Nothing here yet')}
            hint={
              term || activeFilterCount
                ? 'Try a different search or clear the filters.'
                : emptyHint
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 text-left">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => toggleSort(c)}
                      className={`px-4 sm:px-5 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide whitespace-nowrap ${
                        c.align === 'right' ? 'text-right' : ''
                      } ${c.hideOnMobile ? 'hidden sm:table-cell' : ''} ${
                        c.sortable === false ? '' : 'cursor-pointer hover:text-white select-none'
                      }`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {c.header}
                        {sortKey === c.key && (
                          sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={() => onRowClick?.(row)}
                    className={`border-b border-slate-800/60 last:border-0 ${
                      onRowClick ? 'cursor-pointer hover:bg-slate-800/40' : ''
                    } transition-colors`}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-4 sm:px-5 py-3.5 text-sm text-slate-300 ${
                          c.align === 'right' ? 'text-right' : ''
                        } ${c.hideOnMobile ? 'hidden sm:table-cell' : ''}`}
                      >
                        {c.render ? c.render(row) : String(cellValue(row, c) ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer */}
      {!loading && !error && paged.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-3">
          <p className="text-slate-600 text-xs">
            {serverMode
              ? `Page ${currentPage + 1}`
              : `${localPage * pageSize + 1}–${Math.min((localPage + 1) * pageSize, sorted.length)} of ${sorted.length}`}
            {truncatedAt != null && rows.length >= truncatedAt && (
              <span className="text-amber-400/80">
                {' '}· showing the first {truncatedAt}, more exist beyond this
              </span>
            )}
          </p>

          {(canPrev || canNext) && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => goTo(currentPage - 1)}
                disabled={!canPrev}
                className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                <ChevronLeft size={13} /> Previous
              </button>
              <button
                onClick={() => goTo(currentPage + 1)}
                disabled={!canNext}
                className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                Next <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * CSV that survives Excel.
 *
 * Quotes anything containing a comma, quote or newline, and escapes embedded
 * quotes by doubling them. Without this a single agency name with a comma
 * silently shifts every following column.
 */
export function downloadCsv(rows: (string | number | null | undefined)[][], name: string) {
  const escape = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map((r) => r.map(escape).join(',')).join('\r\n')

  // BOM so Excel reads it as UTF-8 rather than mangling ₹ and non-Latin names.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
