import dynamic from 'next/dynamic'

const Client = dynamic(() => import('./Client'), { ssr: false })

export function generateStaticParams() { return [{ uid: '_' }] }

export default function Page() { return <Client /> }
