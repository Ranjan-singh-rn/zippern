import ApprovalDetailClient from './Client'

export function generateStaticParams() { return [{ id: '_' }] }

export default function ApprovalDetailPage({ params }: { params: { id: string } }) {
  return <ApprovalDetailClient id={params.id} />
}
