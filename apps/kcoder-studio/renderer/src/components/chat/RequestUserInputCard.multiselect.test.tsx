import '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'
const question={id:'materials',header:'Materials',question:'Choose supporting materials',isOther:false,options:[{label:'Report A',description:'First evidence'},{label:'Report B',description:'Second evidence'},{label:'Report C',description:'Third evidence'}]}
test.each(['multiSelect','multi_select'] as const)('actual %s flag keeps choices independent and submits one exact multiple-answer response',field=>{
  const submit=vi.fn()
  render(<RequestUserInputCard payload={{requestId:2000001,itemId:'question-2000001',questions:[{...question,[field]:true}]}} onSubmit={submit}/>)
  const first=screen.getByTestId('request-user-input-option-materials-0'),second=screen.getByTestId('request-user-input-option-materials-1')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  fireEvent.click(first);expect(first).toHaveAttribute('aria-pressed','true');expect(submit).not.toHaveBeenCalled()
  fireEvent.click(second);expect(second).toHaveAttribute('aria-pressed','true');expect(first).toHaveAttribute('aria-pressed','true');expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith({requestId:2000001,itemId:'question-2000001',answers:{materials:{answers:['Report A','Report B']}}})
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'));expect(submit).toHaveBeenCalledOnce()
})
test('multiple choice supports deselection and one free answer without preselecting a hidden first option',()=>{
  const submit=vi.fn()
  render(<RequestUserInputCard payload={{requestId:9,questions:[{...question,multiSelect:true,isOther:true}]}} onSubmit={submit}/>)
  const first=screen.getByTestId('request-user-input-option-materials-0'),second=screen.getByTestId('request-user-input-option-materials-1')
  const custom=screen.getByTestId('request-user-input-custom-materials')
  expect(custom).toHaveValue('')
  fireEvent.click(first);fireEvent.click(second);fireEvent.click(first)
  expect(first).toHaveAttribute('aria-pressed','false');expect(second).toHaveAttribute('aria-pressed','true')
  fireEvent.change(custom,{target:{value:'Manual evidence'}})
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({answers:{materials:{answers:['Report B','Manual evidence']}}}))
})
test('omitted multiple-choice flag keeps the original immediate single-choice behavior',()=>{
  const submit=vi.fn()
  render(<RequestUserInputCard payload={{requestId:5,questions:[question]}} onSubmit={submit}/>)
  fireEvent.click(screen.getByTestId('request-user-input-option-materials-1'))
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({answers:{materials:{answers:['Report B']}}}))
})
