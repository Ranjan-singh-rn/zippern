'use client'

import { useState, useEffect } from 'react'
import {
  FileText,
  Shield,
  HelpCircle,
  Loader2,
  Save,
  Globe,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from 'lucide-react'
import { getPolicy, updatePolicy, publishPolicy, Policy } from '@/lib/policies'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'

// ── Tab config ────────────────────────────────────────────────────────────────

type DocType = 'privacy_policy' | 'terms_of_service' | 'faq'

const TABS: { key: DocType; label: string; icon: React.ElementType }[] = [
  { key: 'privacy_policy', label: 'Privacy Policy', icon: Shield },
  { key: 'terms_of_service', label: 'Terms of Service', icon: FileText },
  { key: 'faq', label: 'FAQ', icon: HelpCircle },
]

const ALLOWED_ROLES = ['superadmin', 'app_admin'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: any): string {
  if (!ts) return '—'
  try {
    return ts.toDate().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

// ── Policy Editor ─────────────────────────────────────────────────────────────

function PolicyEditor({
  docType,
  crmUser,
}: {
  docType: DocType
  crmUser: { uid: string; name: string } | null
}) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [showPublishWarning, setShowPublishWarning] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    setLoading(true)
    setIsDirty(false)
    getPolicy(docType)
      .then((p) => {
        setPolicy(p)
        setContent(p?.content ?? '')
      })
      .catch((err) => {
        console.error(err)
        showToast('error', 'Failed to load policy.')
      })
      .finally(() => setLoading(false))
  }, [docType])

  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3500)
  }

  const handleSaveDraft = async () => {
    if (!crmUser) return
    setSaving(true)
    try {
      await updatePolicy(docType, content, crmUser.uid, crmUser.name)
      // Refresh
      const updated = await getPolicy(docType)
      setPolicy(updated)
      setIsDirty(false)
      showToast('success', 'Draft saved successfully.')
    } catch (err) {
      console.error('Save draft failed:', err)
      showToast('error', 'Failed to save draft.')
    } finally {
      setSaving(false)
    }
  }

  const handlePublish = async () => {
    setPublishing(true)
    setShowPublishWarning(false)
    try {
      await publishPolicy(docType)
      setPolicy((prev) => (prev ? { ...prev, isPublished: true } : prev))
      showToast('success', 'Policy published and now visible to all app users.')
    } catch (err) {
      console.error('Publish failed:', err)
      showToast('error', 'Failed to publish policy.')
    } finally {
      setPublishing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-slate-400 py-20">
        <Loader2 size={20} className="animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${
            toast.type === 'success'
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 size={15} />
          ) : (
            <AlertTriangle size={15} />
          )}
          {toast.text}
        </div>
      )}

      {/* Meta info bar */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-slate-800 border border-slate-700 rounded-xl text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Version</span>
          <span className="text-white font-semibold">v{policy?.version ?? 0}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Last updated</span>
          <span className="text-slate-300">{formatDate(policy?.updatedAt)}</span>
        </div>
        {policy?.lastUpdatedByName && (
          <div className="flex items-center gap-2">
            <span className="text-slate-500">By</span>
            <span className="text-slate-300">{policy.lastUpdatedByName}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {policy?.isPublished ? (
            <>
              <Globe size={13} className="text-green-400" />
              <span className="text-green-400 font-medium">Published</span>
              <span className="text-slate-500 text-xs">
                {policy.publishedAt ? formatDate(policy.publishedAt) : ''}
              </span>
            </>
          ) : (
            <>
              <Clock size={13} className="text-yellow-400" />
              <span className="text-yellow-400 font-medium">Draft</span>
            </>
          )}
        </div>
      </div>

      {/* Published info */}
      {policy?.isPublished && policy?.publishedAt && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-green-500/5 border border-green-500/20 rounded-xl text-xs text-green-400">
          <CheckCircle2 size={13} />
          Last published version: v{policy.version} on {formatDate(policy.publishedAt)}
        </div>
      )}

      {/* Editor */}
      <div>
        <label className="block text-slate-400 text-xs font-medium mb-2">
          Content (plain text or Markdown)
        </label>
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            setIsDirty(true)
          }}
          placeholder="Enter policy content here..."
          rows={24}
          className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-y transition-colors font-mono leading-relaxed"
        />
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleSaveDraft}
          disabled={saving || !isDirty || !crmUser}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors text-sm"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          Save Draft
        </button>

        <button
          onClick={() => setShowPublishWarning(true)}
          disabled={publishing || !policy || !content.trim() || !crmUser}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors text-sm"
        >
          {publishing ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />}
          Publish
        </button>

        {isDirty && (
          <span className="text-yellow-400 text-xs flex items-center gap-1">
            <AlertTriangle size={12} />
            Unsaved changes
          </span>
        )}
      </div>

      {/* Publish confirmation modal */}
      {showPublishWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center">
                <AlertTriangle size={18} className="text-yellow-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">Publish Policy?</h3>
                <p className="text-slate-400 text-sm">
                  This will be visible to all app users immediately.
                </p>
              </div>
            </div>
            <p className="text-slate-400 text-sm mb-5">
              Make sure you have saved your latest changes as a draft before publishing. This action
              cannot be undone — the policy will go live for all Zipper users.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handlePublish}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors"
              >
                <Globe size={15} />
                Yes, Publish Now
              </button>
              <button
                onClick={() => setShowPublishWarning(false)}
                className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PoliciesPage() {
  const { crmUser } = useAuth()
  const [activeTab, setActiveTab] = useState<DocType>('privacy_policy')

  if (!crmUser || !canAccess(crmUser, [...ALLOWED_ROLES])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Policies</h1>
        <p className="text-slate-400 mt-1">
          Manage Privacy Policy, Terms of Service, and FAQ shown to app users
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800 border border-slate-700 rounded-xl p-1 mb-6 overflow-x-auto w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {/* Editor for active tab */}
      <PolicyEditor
        key={activeTab}
        docType={activeTab}
        crmUser={crmUser ? { uid: crmUser.uid, name: crmUser.name } : null}
      />
    </div>
  )
}
