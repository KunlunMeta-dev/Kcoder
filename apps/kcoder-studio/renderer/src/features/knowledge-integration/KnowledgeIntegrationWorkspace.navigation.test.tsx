import {render,screen} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {KnowledgeIntegrationWorkspace} from './KnowledgeIntegrationWorkspace'
import type {KnowledgeIntegrationClient} from './client'
vi.mock('@/hooks/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('./MemoryCenter',()=>({MemoryCenter:()=> <div data-testid="embedded-memory"/>}))
vi.mock('./BusinessSubscriptions',()=>({BusinessSubscriptions:()=> <div data-testid="embedded-automation"/>}))

it('legacy workspace exposes memory but has no shared publication navigation or mount',()=>{
 render(<KnowledgeIntegrationWorkspace client={{ownerKey:'owned'} as KnowledgeIntegrationClient}/>)
 expect(screen.getByTestId('embedded-memory')).toBeInTheDocument()
 expect(screen.queryByTestId('knowledge-section-knowledge')).not.toBeInTheDocument()
 expect(screen.queryByTestId('knowledge-publications')).not.toBeInTheDocument()
 expect(screen.queryByTestId('knowledge-import-files')).not.toBeInTheDocument()
})
