import { useCallback, useEffect, useState } from 'react'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { SourceUploadState } from '../../../../shared/generated/contracts'
import { MigrationSourceUploadPanel } from './MigrationSourceUploadPanel'
import { MigrationSourceProductPanel } from './MigrationSourceProductPanel'
import { MigrationSourceBrowser } from './MigrationSourceBrowser'

/** The two Ready states are independent. Source queries start only after explicit inspection. */
export function MigrationSourceUploadWorkspace({ target, targets, isCurrent, onBusy, onOpenBatch }: {
  target: GatewayServer; targets: GatewayServer[]; isCurrent: () => boolean; onBusy: (busy: boolean) => void;
  onOpenBatch?: (jobId: string) => void
}) {
  const [upload, setUpload] = useState<SourceUploadState | null>(null), [product, setProduct] = useState<SourceUploadState | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false), [productBusy, setProductBusy] = useState(false), [sourceBusy, setSourceBusy] = useState(false)
  useEffect(() => { onBusy(uploadBusy || productBusy || sourceBusy); return () => onBusy(false) }, [uploadBusy, productBusy, sourceBusy, onBusy])
  const identityChanged = useCallback((id: string | null) => {
    setUpload(previous => previous && previous.operationId === id ? previous : null)
    setProduct(previous => previous && previous.operationId === id ? previous : null)
  }, [])
  const productUnavailable = useCallback((id: string) => setProduct(previous => previous?.operationId === id ? null : previous), [])
  return <>
    <MigrationSourceUploadPanel target={target} isCurrent={isCurrent} onBusy={setUploadBusy} onIdentityChanged={identityChanged}
      onUse={value => { if (isCurrent() && value.stage === 'ready') { setUpload(value); setProduct(null) } }}/>
    {upload && <MigrationSourceProductPanel key={`${upload.operationId}:${upload.manifestSha256}`} target={target} upload={upload} isCurrent={isCurrent} onBusy={setProductBusy} onUnavailable={productUnavailable}
      onInspect={value => { if (isCurrent() && value.stage === 'ready') setProduct(value) }}/>}
    {product && <MigrationSourceBrowser key={`${product.operationId}:${product.manifestSha256}`} targets={targets} destination={target} uploaded={product} isCurrent={isCurrent} onBusy={setSourceBusy} onOpenBatch={onOpenBatch}/>}
  </>
}
