import type { HttpClient } from './http'
import type { UnifiedModelListResponse } from '@/types/api'

export interface ModelCatalogTarget {
  taskId?: string
  deviceId?: string
  workspacePath?: string
}

export function createModelApi(client: HttpClient) {
  return {
    // Hosted catalogs do not use Gateway execution targets.
    listModels(_target?: ModelCatalogTarget): Promise<UnifiedModelListResponse> {
      void _target
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      return client.get(`/models/unified?${query.toString()}`)
    },
  }
}
