// model protocol server for the existing desktop runner.
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  customToolCall,
  functionCall,
  json,
  localModelSwitchCommand,
  localProtocolPatch,
  localProtocolPrompt,
  matrixCaseId,
  matrixPatch,
  matrixTextCompletion,
  matrixTextPrompt,
  matrixToolCompletion,
  matrixToolPrompt,
  responseCompleted,
  responseCreated,
  responseFailed,
  streamingTextEvents,
} from './model-bindings.mjs'
import {
  CUSTOM_TOOL_INPUT_DESCRIPTION,
  LOCAL_MODEL_SWITCH_COMPLETE,
  LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT,
  LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
  LOCAL_MODEL_SWITCH_INITIAL_PROMPT,
  LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
  MODEL_API_KEY,
  PROVIDER_SWITCH_COMPLETION,
  PROVIDER_SWITCH_FAILURE,
  PROVIDER_SWITCH_LUNA_MODEL_ID,
  PROVIDER_SWITCH_PROMPT,
  PROVIDER_SWITCH_SOL_OPTION_ID,
} from './config.mjs'
import { delay } from './runtime.mjs'
import assert from 'node:assert/strict'

export class DesktopProtocolServer {
  handleProviderSwitchRetryResponse(response, protocol, body, modelRequest) {
    assert.equal(protocol, 'responses', 'The provider-switch request reached the wrong endpoint')
    const requestKind = codexRequestKind(body)
    if (requestKind === 'prewarm' || requestKind === 'compaction') {
      const responseId = `provider-switch-background-${this.modelRequests.length}`
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    assert.ok(
      JSON.stringify(body).includes(PROVIDER_SWITCH_PROMPT),
      'The provider-switch request lost the user prompt'
    )
    this.recordScenarioRequest('provider_switch_retry', modelRequest)
    const promptRequestCount = this.scenarioRequests.get('provider_switch_retry').length
    if (promptRequestCount === 1) {
      assert.equal(
        body.model,
        PROVIDER_SWITCH_LUNA_MODEL_ID,
        'The initial provider-switch turn did not reach Luna'
      )
      json(response, 400, {
        error: {
          type: 'invalid_request_error',
          message: PROVIDER_SWITCH_FAILURE,
        },
      })
      return
    }
    if (promptRequestCount === 2) {
      assert.equal(
        body.model,
        PROVIDER_SWITCH_SOL_OPTION_ID,
        `The provider-switch retry was still routed to ${String(body.model)}`
      )
      const responseId = 'provider-switch-sol-complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PROVIDER_SWITCH_COMPLETION),
        responseCompleted(responseId),
      ])
      return
    }
    throw new Error(`The provider-switch prompt was sent ${promptRequestCount} times`)
  }
  handleModelProtocolMatrixResponse(response, protocol, body, headers) {
    const model = this.matrixCase
    const state = this.matrixState
    assert.ok(model && state, 'Model protocol matrix state was not initialized')
    assert.equal(protocol, model.protocol, `${matrixCaseId(model)} reached the wrong endpoint`)
    assert.equal(body.model, model.modelId, `${matrixCaseId(model)} forwarded the wrong model ID`)
    state.requests.push({ body, headers })

    const requestKind = codexRequestKind(body)
    if (requestKind === 'prewarm' || requestKind === 'compaction') {
      this.writeMatrixAssistantMessage(response, model, '')
      return
    }

    const serialized = JSON.stringify(body)
    this.assertMatrixRequestEnvelope(model, body, headers)
    this.assertMatrixTools(model, body)
    if (state.stage === 'text') {
      if (!serialized.includes(matrixTextPrompt(model))) {
        this.writeMatrixAssistantMessage(response, model, '')
        return
      }
      state.stage = 'tool'
      this.writeMatrixAssistantMessage(response, model, matrixTextCompletion(model))
      return
    }
    if (state.stage === 'tool') {
      assert.ok(
        serialized.includes(matrixToolPrompt(model)),
        `${matrixCaseId(model)} tool turn lost the user prompt`
      )
      state.stage = 'awaiting_tool_output'
      this.writeMatrixToolCall(response, model)
      return
    }
    if (state.stage === 'awaiting_tool_output') {
      this.assertMatrixToolOutput(model, body)
      state.stage = 'complete'
      this.writeMatrixAssistantMessage(response, model, matrixToolCompletion(model))
      return
    }
    throw new Error(`Unexpected ${matrixCaseId(model)} matrix request at ${state.stage}`)
  }
  assertMatrixRequestEnvelope(model, body, headers) {
    assert.equal(body.stream, true, `${matrixCaseId(model)} request was not streaming`)
    if (model.protocol === 'responses') {
      assert.ok(Array.isArray(body.input), `${matrixCaseId(model)} input was not an array`)
      return
    }
    assert.ok(Array.isArray(body.messages), `${matrixCaseId(model)} messages were not an array`)
    if (model.protocol === 'chat') {
      assert.equal(
        body.stream_options?.include_usage,
        true,
        `${matrixCaseId(model)} did not request streaming usage`
      )
      return
    }
    assert.equal(headers['x-api-key'], MODEL_API_KEY, `${matrixCaseId(model)} lost x-api-key`)
    assert.equal(
      headers['anthropic-version'],
      '2023-06-01',
      `${matrixCaseId(model)} lost the Anthropic protocol version`
    )
  }
  assertMatrixTools(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const applyPatch = tools.find(
      candidate => (candidate?.name ?? candidate?.function?.name) === 'apply_patch'
    )
    assert.ok(applyPatch, `${matrixCaseId(model)} did not advertise apply_patch`)
    if (model.protocol === 'responses') {
      assert.equal(
        applyPatch.type,
        model.source === 'local' ? 'function' : 'custom',
        `${matrixCaseId(model)} used the wrong Responses tool profile`
      )
      return
    }
    if (model.protocol === 'chat') {
      assert.equal(applyPatch.type, 'function', `${matrixCaseId(model)} tool was not a function`)
      assert.ok(applyPatch.function?.parameters, `${matrixCaseId(model)} lost the tool schema`)
      return
    }
    assert.ok(applyPatch.input_schema, `${matrixCaseId(model)} lost input_schema`)
  }
  assertMatrixToolOutput(model, body) {
    if (model.protocol === 'responses') {
      const expectedType =
        model.source === 'local' ? 'function_call_output' : 'custom_tool_call_output'
      assert.ok(
        body.input?.some(item => item?.type === expectedType),
        `${matrixCaseId(model)} lost ${expectedType}`
      )
      return
    }
    if (model.protocol === 'chat') {
      assert.ok(
        body.messages?.some(message => message?.role === 'tool'),
        `${matrixCaseId(model)} lost the function tool result`
      )
      return
    }
    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    assert.ok(
      blocks.some(block => block?.type === 'tool_result'),
      `${matrixCaseId(model)} lost the Anthropic tool_result`
    )
  }
  writeMatrixToolCall(response, model) {
    const patch = matrixPatch(model)
    if (model.protocol === 'responses') {
      const id = `matrix-${matrixCaseId(model)}-tool`
      this.writeSse(response, [
        responseCreated(id),
        ...(model.source === 'local'
          ? functionCall(id, 'apply_patch', { input: patch })
          : [customToolCall(id, 'apply_patch', patch)]),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, patch)
      return
    }
    this.writeAnthropicToolCall(response, patch)
  }
  writeMatrixAssistantMessage(response, model, text) {
    if (model.protocol === 'responses') {
      const id = `matrix-${matrixCaseId(model)}-message`
      const events = [responseCreated(id)]
      if (text) events.push(assistantMessage(text))
      events.push(responseCompleted(id))
      this.writeSse(response, events)
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatMessage(response, text)
      return
    }
    this.writeAnthropicMessage(response, text)
  }
  handleLocalProtocolResponse(response, model, body, headers) {
    const state = this.localProtocolStates.get(model.protocol)
    assert.ok(state, `Missing local protocol state for ${model.protocol}`)
    state.requests.push({ body, headers })
    const serialized = JSON.stringify(body)
    const initialPrompt = localProtocolPrompt(model, 'INITIAL')
    const followUpPrompt = localProtocolPrompt(model, 'FOLLOW_UP')

    this.assertLocalRequestEnvelope(model, body, headers)

    if (state.stage === 'model_switch_source') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_INITIAL_PROMPT),
        'The first custom model did not receive the model-switch initial prompt'
      )
      state.stage = 'model_switch_source_awaiting_tool_output'
      this.writeModelSwitchToolCall(response, model)
      return
    }
    if (state.stage === 'model_switch_source_awaiting_tool_output') {
      this.assertModelSwitchHistory(model, body)
      state.stage = 'model_switch_source_complete'
      this.writeLocalAssistantMessage(response, model, LOCAL_MODEL_SWITCH_INITIAL_COMPLETE)
      return
    }
    if (state.stage === 'model_switch_source_complete') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT),
        'The first custom model did not receive the prompt that should fail before switching'
      )
      state.stage = 'model_switch_source_failed'
      this.writeLocalError(response, model, 'KCODER_STUDIO_LOCAL_MODEL_SWITCH_RETRY_FAILURE')
      return
    }
    if (state.stage === 'model_switch_source_failed' && codexRequestKind(body) === 'compaction') {
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    if (
      state.stage === 'model_switch_source_failed' &&
      serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT)
    ) {
      this.writeLocalError(response, model, 'KCODER_STUDIO_LOCAL_MODEL_SWITCH_RETRY_FAILURE')
      return
    }
    if (
      state.stage === 'model_switch_target' &&
      (codexRequestKind(body) === 'compaction' ||
        serialized.includes('CONTEXT CHECKPOINT COMPACTION'))
    ) {
      if (this.hasModelSwitchHistory(model, body)) {
        this.assertModelSwitchHistory(model, body)
        state.historyVerified = true
      }
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    if (state.stage === 'model_switch_target') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT),
        'The second custom model did not receive the follow-up after switching models'
      )
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_INITIAL_COMPLETE),
        'The switched custom model did not preserve the earlier conversation context'
      )
      if (!state.historyVerified) {
        this.assertModelSwitchHistory(model, body)
        state.historyVerified = true
      }
      state.stage = 'model_switch_target_complete'
      this.writeLocalAssistantMessage(response, model, LOCAL_MODEL_SWITCH_COMPLETE)
      return
    }

    if (state.stage === 'initial' && serialized.includes(initialPrompt)) {
      this.assertLocalConversation(model, body, {
        includes: [initialPrompt],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalNamespaceTools(model, body)
      if (model.protocol !== 'responses') {
        state.stage = 'awaiting_namespace_tool_output'
        this.writeLocalNamespaceToolCall(response, model)
        return
      }
      state.stage = 'awaiting_tool_output'
      this.writeLocalToolCall(response, model, localProtocolPatch(model))
      return
    }
    if (state.stage === 'awaiting_namespace_tool_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalNamespaceTools(model, body)
      this.assertLocalNamespaceToolOutput(model, body)
      state.stage = 'awaiting_tool_output'
      this.writeLocalToolCall(response, model, localProtocolPatch(model))
      return
    }
    if (state.stage === 'awaiting_tool_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalToolOutput(model, body)
      state.stage = 'complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `KCODER_STUDIO_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      )
      return
    }
    if (state.stage === 'complete' && serialized.includes(followUpPrompt)) {
      const completedMessage = `KCODER_STUDIO_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      this.assertLocalConversation(model, body, {
        includes:
          model.protocol === 'responses'
            ? [initialPrompt, followUpPrompt, completedMessage]
            : [initialPrompt, followUpPrompt, completedMessage],
        excludes: [],
      })
      this.assertLocalApplyPatchTool(model, body)
      // Stateful Responses requests may compact completed tool call/output pairs.
      // Stateless Chat and Anthropic conversions must keep the pair for history.
      if (model.protocol !== 'responses') this.assertLocalToolOutput(model, body)
      state.stage = 'follow_up_complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `KCODER_STUDIO_LOCAL_${model.protocol.toUpperCase()}_FOLLOW_UP_COMPLETE`
      )
      return
    }
    // Codex may prewarm a provider before it sends the first prompt and tools.
    if (state.stage === 'initial') {
      assert.equal(
        serialized.includes(initialPrompt),
        false,
        `${model.protocol} prewarm unexpectedly contained the initial prompt`
      )
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    throw new Error(
      `Unexpected ${model.protocol} request at ${state.stage}: ${serialized.slice(0, 1000)}`
    )
  }
  assertLocalRequestEnvelope(model, body, headers) {
    assert.equal(body.model, model.modelId, `${model.protocol} forwarded the wrong model ID`)
    assert.equal(body.stream, true, `${model.protocol} request was not streaming`)
    assert.equal(
      headers.authorization,
      `Bearer ${MODEL_API_KEY}`,
      `${model.protocol} did not forward bearer authentication`
    )
    if (model.protocol === 'responses') {
      assert.ok(Array.isArray(body.input), 'Responses input was not an array')
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Responses unexpectedly received Anthropic headers'
      )
      return
    }
    assert.ok(Array.isArray(body.messages), `${model.protocol} messages were not an array`)
    if (model.protocol === 'chat') {
      assert.equal(
        body.stream_options?.include_usage,
        true,
        'Chat streaming usage metadata was not requested'
      )
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Chat unexpectedly received Anthropic headers'
      )
      return
    }
    assert.equal(headers['x-api-key'], MODEL_API_KEY, 'Anthropic x-api-key was not forwarded')
    assert.equal(
      headers['anthropic-version'],
      '2023-06-01',
      'Anthropic protocol version was not forwarded'
    )
    assert.ok(
      typeof body.system === 'string' && body.system.length > 0,
      'Anthropic system instructions were not preserved'
    )
    assert.ok(body.max_tokens > 0, 'Anthropic max_tokens was not populated')
  }
  assertLocalConversation(model, body, { includes, excludes }) {
    const serialized = JSON.stringify(body)
    for (const value of includes) {
      assert.ok(serialized.includes(value), `${model.protocol} request lost history: ${value}`)
    }
    for (const value of excludes) {
      assert.equal(
        serialized.includes(value),
        false,
        `${model.protocol} request leaked future history: ${value}`
      )
    }
  }
  assertLocalApplyPatchTool(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const tool = tools.find(
      candidate => (candidate?.name ?? candidate?.function?.name) === 'apply_patch'
    )
    assert.ok(tool, `${model.protocol} did not receive apply_patch`)
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)
    assert.ok(
      names.includes('shell_command') || names.includes('exec_command'),
      `${model.protocol} did not receive a shell tool: ${names.join(', ')}`
    )
    if (model.protocol === 'responses') {
      assert.equal(tool.type, 'function', 'Responses apply_patch was not converted to function')
      const description = tool.description ?? ''
      this.assertApplyPatchOutputContract(model, description)
      assert.deepEqual(
        tool.parameters,
        {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        'Responses apply_patch wrapper schema was not preserved'
      )
      return
    }
    if (model.protocol === 'chat') {
      assert.equal(tool.type, 'function', 'Chat apply_patch was not converted to function')
      const description = tool.function?.description ?? ''
      assert.match(
        description,
        /Original tool definition:[\s\S]*"syntax":"lark"/,
        'Chat apply_patch lost its custom grammar'
      )
      this.assertApplyPatchOutputContract(model, description)
      assert.deepEqual(
        tool.function?.parameters,
        {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        'Chat apply_patch wrapper schema was not preserved'
      )
      return
    }
    assert.ok(tool.input_schema, 'Anthropic apply_patch input_schema was missing')
    const description = tool.description ?? ''
    assert.match(
      description,
      /Original tool definition:[\s\S]*"syntax":"lark"/,
      'Anthropic apply_patch lost its custom grammar'
    )
    this.assertApplyPatchOutputContract(model, description)
    assert.deepEqual(
      tool.input_schema,
      {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: CUSTOM_TOOL_INPUT_DESCRIPTION,
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
      'Anthropic apply_patch wrapper schema was not preserved'
    )
  }
  assertLocalNamespaceTools(model, body) {
    if (model.protocol === 'responses') return
    const tools = Array.isArray(body.tools) ? body.tools : []
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)

    assert.ok(
      names.includes('browser_snapshot'),
      `${model.protocol} did not flatten the wework_browser namespace: ${names.join(', ')}`
    )
    assert.equal(
      names.includes('wework_browser'),
      false,
      `${model.protocol} exposed the namespace container as a callable function`
    )
  }
  assertLocalNamespaceToolOutput(model, body) {
    const serialized = JSON.stringify(body)
    assert.equal(
      serialized.includes('unsupported function call: browser_snapshot'),
      false,
      `${model.protocol} did not restore the wework_browser namespace on the tool call`
    )

    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'browser_snapshot')
      assert.ok(call, 'Chat lost the flattened browser_snapshot call history')
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the namespaced browser_snapshot result'
      )
      return
    }

    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(
      block => block?.type === 'tool_use' && block?.name === 'browser_snapshot'
    )
    assert.ok(call, 'Anthropic lost the flattened browser_snapshot call history')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the namespaced browser_snapshot result'
    )
  }
  assertApplyPatchOutputContract(model, description) {
    for (const instruction of [
      'Critical apply_patch input contract:',
      'exactly `*** Begin Patch\\n`',
      'with no blank line',
      'Do not include Markdown code fences',
      'every added-file content line must start with `+`',
    ]) {
      assert.ok(
        description.includes(instruction),
        `${model.protocol} apply_patch wrapper omitted instruction: ${instruction}`
      )
    }
  }
  assertLocalToolOutput(model, body) {
    const patch = localProtocolPatch(model)
    if (model.protocol === 'responses') {
      const output = body.input?.find(item => item?.type === 'function_call_output')
      assert.equal(
        output?.call_id,
        'local-responses-tool',
        'Responses lost the apply_patch call ID'
      )
      assert.ok(output?.output, 'Responses lost the apply_patch output')
      return
    }
    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'apply_patch')
      assert.deepEqual(
        JSON.parse(call?.function?.arguments ?? '{}'),
        { input: patch },
        'Chat changed the wrapped apply_patch input'
      )
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the function tool result or call ID'
      )
      return
    }
    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(block => block?.type === 'tool_use' && block?.name === 'apply_patch')
    assert.deepEqual(call?.input, { input: patch }, 'Anthropic changed the apply_patch input')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the tool_result block or tool_use_id'
    )
  }
  assertModelSwitchHistory(model, body) {
    const serialized = JSON.stringify(body)
    assert.ok(
      !serialized.includes(LOCAL_MODEL_SWITCH_INVALID_CALL_ID),
      `${model.protocol} received the original invalid provider tool call ID`
    )

    if (model.protocol === 'responses') {
      const items = Array.isArray(body.input) ? body.input : []
      const call = items.find(
        item => item?.type === 'function_call' && item?.name === 'exec_command'
      )
      const output = items.find(item => item?.type === 'function_call_output')

      assert.ok(call, 'Responses lost the converted exec_command call history')
      assert.ok(output, 'Responses lost the converted exec_command output history')
      if (call.id != null) {
        assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Responses received an invalid item ID')
      }
      assert.match(call.call_id, /^[A-Za-z0-9_-]+$/, 'Responses received an invalid call ID')
      assert.equal(
        output.call_id,
        call.call_id,
        'Responses broke the cross-protocol tool call/output association'
      )
      return
    }

    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'exec_command')
      const output = body.messages?.find(
        message => message?.role === 'tool' && message?.tool_call_id === call?.id
      )

      assert.ok(call, 'Chat lost the converted exec_command call history')
      assert.ok(output, 'Chat lost the converted exec_command output history')
      assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Chat received an invalid tool call ID')
      assert.deepEqual(
        JSON.parse(call.function?.arguments ?? '{}'),
        { cmd: localModelSwitchCommand() },
        'Chat changed the exec_command arguments during protocol conversion'
      )
      return
    }

    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(block => block?.type === 'tool_use' && block?.name === 'exec_command')
    const output = blocks.find(
      block => block?.type === 'tool_result' && block?.tool_use_id === call?.id
    )

    assert.ok(call, 'Anthropic lost the converted exec_command call history')
    assert.ok(output, 'Anthropic lost the converted exec_command output history')
    assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Anthropic received an invalid tool use ID')
    assert.deepEqual(
      call.input,
      { cmd: localModelSwitchCommand() },
      'Anthropic changed the exec_command input during protocol conversion'
    )
  }
  hasModelSwitchHistory(model, body) {
    if (model.protocol === 'responses') {
      return body.input?.some(
        item => item?.type === 'function_call' && item?.name === 'exec_command'
      )
    }
    if (model.protocol === 'chat') {
      return body.messages?.some(message =>
        message?.tool_calls?.some(call => call?.function?.name === 'exec_command')
      )
    }
    return body.messages?.some(message =>
      message?.content?.some(block => block?.type === 'tool_use' && block?.name === 'exec_command')
    )
  }
  writeModelSwitchToolCall(response, model) {
    const toolInput = { cmd: localModelSwitchCommand() }
    if (model.protocol === 'responses') {
      const responseId = 'responses-model-switch-tool'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall(LOCAL_MODEL_SWITCH_INVALID_CALL_ID, 'exec_command', toolInput),
        responseCompleted(responseId),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(
        response,
        toolInput,
        LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
        'exec_command'
      )
      return
    }
    this.writeAnthropicToolCall(
      response,
      toolInput,
      LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
      'exec_command'
    )
  }
  writeLocalError(response, model, message) {
    if (model.protocol === 'responses') {
      const responseId = 'responses-model-switch-error'
      this.writeSse(response, [responseCreated(responseId), responseFailed(responseId, message)])
      return
    }
    if (model.protocol === 'chat') {
      json(response, 400, {
        error: { type: 'invalid_request_error', message },
      })
      return
    }
    this.writeAnthropicError(response, message)
  }
  writeLocalToolCall(response, model, patch) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-tool`
      this.writeSse(response, [
        responseCreated(id),
        ...functionCall(id, 'apply_patch', { input: patch }),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, patch)
      return
    }
    this.writeAnthropicToolCall(response, patch)
  }
  writeLocalNamespaceToolCall(response, model) {
    const callId = `${model.protocol}-local-browser-snapshot`
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, {}, callId, 'browser_snapshot')
      return
    }
    this.writeAnthropicToolCall(response, {}, callId, 'browser_snapshot')
  }
  writeLocalAssistantMessage(response, model, text) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-message`
      const events = [responseCreated(id)]
      if (text) events.push(assistantMessage(text))
      events.push(responseCompleted(id))
      this.writeSse(response, events)
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatMessage(response, text)
      return
    }
    this.writeAnthropicMessage(response, text)
  }
  writeChatToolCall(
    response,
    toolInput,
    callId = 'chat-local-apply-patch',
    toolName = 'apply_patch'
  ) {
    const argumentsValue = JSON.stringify(
      toolName === 'apply_patch' ? { input: toolInput } : toolInput
    )
    const splitAt = Math.max(1, Math.floor(argumentsValue.length / 2))
    const chunks = [
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: argumentsValue.slice(0, splitAt),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  function: {
                    name: toolName,
                    arguments: argumentsValue.slice(splitAt),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]
    this.writeRawSse(
      response,
      `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
    )
  }
  writeChatMessage(response, text) {
    const chunk = {
      id: 'chat-local-message',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }
    this.writeRawSse(response, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  }
  writeAnthropicToolCall(
    response,
    toolInput,
    callId = 'anthropic-local-apply-patch',
    toolName = 'apply_patch'
  ) {
    const input = JSON.stringify(toolName === 'apply_patch' ? { input: toolInput } : toolInput)
    this.writeAnthropicSse(response, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-tool',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: toolName,
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: input },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  }
  writeAnthropicError(response, message) {
    this.writeAnthropicSse(response, [
      [
        'error',
        {
          type: 'error',
          error: { type: 'invalid_request_error', message },
        },
      ],
    ])
  }
  writeAnthropicMessage(response, text) {
    this.writeAnthropicSse(response, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-message',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  }
  writeAnthropicSse(response, events) {
    this.writeRawSse(
      response,
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    )
  }
  writeRawSse(response, body) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(body)
  }
  writeSse(response, events) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(createSse(events))
  }
  async writeStreamingMarkdown(response, responseId, text) {
    const stream = streamingTextEvents(responseId, text)
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.write(createSse(stream.start))
    let offset = 0
    for (const delta of stream.chunks) {
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta,
            offset,
          },
        ])
      )
      offset += [...delta].length
      await delay(5)
    }
    response.end(createSse(stream.finish))
  }
}
