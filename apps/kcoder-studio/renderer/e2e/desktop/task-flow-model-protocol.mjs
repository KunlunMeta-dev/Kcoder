import assert from 'node:assert/strict'
import { join } from 'node:path'

export function createModelProtocolHelpers(config) {
  const {
    MEMORY_COMPLETION_TEXT,
    LOCAL_MODEL_CASES,
    LOCAL_MODEL_SWITCH_ARTIFACT,
    LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
    MODEL_PROTOCOL_MATRIX_TEXT_PREFIX,
    MODEL_PROTOCOL_MATRIX_TOOL_PREFIX,
    ARTIFACT_NAME,
    ARTIFACT_CONTENT,
    CLOUD_ARTIFACT_NAME,
    CLOUD_ARTIFACT_CONTENT,
    IMAGE_ARTIFACT_NAME,
  } = config

  function createSse(events) {
    return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  }

  function codexRequestKind(body) {
    const metadata = body.client_metadata?.['x-codex-turn-metadata']
    if (typeof metadata !== 'string') return null

    try {
      return JSON.parse(metadata).request_kind ?? null
    } catch {
      return null
    }
  }

  function responseCreated(id) {
    return { type: 'response.created', response: { id } }
  }

  function responseCompleted(id) {
    return {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    }
  }

  function responseFailed(id, message) {
    return {
      type: 'response.failed',
      response: {
        id,
        status: 'failed',
        error: { code: 'context_length_exceeded', message },
      },
    }
  }

  function functionCall(callId, name, argumentsValue) {
    return [
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          call_id: callId,
          name,
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: callId,
          name,
          arguments: JSON.stringify(argumentsValue),
        },
      },
    ]
  }

  function customToolCall(callId, name, input) {
    return {
      type: 'response.output_item.done',
      item: {
        type: 'custom_tool_call',
        call_id: callId,
        name,
        input,
      },
    }
  }

  function assistantMessage(text) {
    return {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: 'studio-e2e-message',
        content: [{ type: 'output_text', text }],
      },
    }
  }

  function streamingMarkdownReport() {
    const section = index =>
      [
        `### Memory section ${index}`,
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        `| Section | ${index} |`,
        '| Rendering | Streaming Markdown |',
        '',
        '```ts',
        `export const memorySection${index} = { enabled: true, index: ${index} }`,
        '```',
        '',
        'This section exercises incremental Markdown parsing, syntax highlighting, React reconciliation, and WebKit layout allocation.',
        '',
      ].join('\n')
    return `${Array.from({ length: 80 }, (_, index) => section(index + 1)).join('\n')}\n${MEMORY_COMPLETION_TEXT}`
  }

  function streamingTextEvents(id, text) {
    const itemId = `${id}-message`
    const chunks = text.match(/[\s\S]{1,48}/g) ?? []
    return {
      chunks,
      start: [
        responseCreated(id),
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: itemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        },
        {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
      ],
      finish: [
        {
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text,
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: itemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        },
        responseCompleted(id),
      ],
      itemId,
    }
  }

  function localProtocolCase(modelId) {
    return LOCAL_MODEL_CASES.find(model => model.modelId === modelId) ?? null
  }

  function localProtocolPrompt(model, phase) {
    return `KCODER_STUDIO_LOCAL_MODEL_${model.protocol.toUpperCase()}_${phase}`
  }

  function localProtocolArtifact(model) {
    return `studio-local-${model.protocol}.txt`
  }

  function localProtocolArtifactContent(model) {
    return `KCODER_STUDIO_LOCAL_${model.protocol.toUpperCase()}_APPLY_PATCH`
  }

  function localProtocolPatch(model) {
    return [
      '*** Begin Patch',
      `*** Add File: ${localProtocolArtifact(model)}`,
      `+${localProtocolArtifactContent(model)}`,
      '*** End Patch',
    ].join('\n')
  }

  function localModelSwitchCommand() {
    return `printf '%s' '${LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT}' > '${LOCAL_MODEL_SWITCH_ARTIFACT}'`
  }

  function matrixCaseId(model) {
    return `${model.execution}-${model.source}-${model.protocol}`
  }

  function matrixTextPrompt(model) {
    return `${MODEL_PROTOCOL_MATRIX_TEXT_PREFIX}_${matrixCaseId(model).toUpperCase()}`
  }

  function matrixTextCompletion(model) {
    return `${matrixTextPrompt(model)}_COMPLETE`
  }

  function matrixToolPrompt(model) {
    return `${MODEL_PROTOCOL_MATRIX_TOOL_PREFIX}_${matrixCaseId(model).toUpperCase()}`
  }

  function matrixToolCompletion(model) {
    return `${matrixToolPrompt(model)}_COMPLETE`
  }

  function matrixArtifact(model) {
    return `studio-matrix-${matrixCaseId(model)}.txt`
  }

  function matrixArtifactContent(model) {
    return `KCODER_STUDIO_MATRIX_${matrixCaseId(model).toUpperCase()}_APPLY_PATCH`
  }

  function matrixPatch(model) {
    return [
      '*** Begin Patch',
      `*** Add File: ${matrixArtifact(model)}`,
      `+${matrixArtifactContent(model)}`,
      '*** End Patch',
    ].join('\n')
  }

  function readRequestBody(request) {
    return new Promise((resolvePromise, reject) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => {
        body += chunk
      })
      request.once('end', () => {
        try {
          resolvePromise(body ? JSON.parse(body) : {})
        } catch (error) {
          reject(error)
        }
      })
      request.once('error', reject)
    })
  }

  function json(response, statusCode, value) {
    response.writeHead(statusCode, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8',
    })
    response.end(`${JSON.stringify(value)}\n`)
  }

  function cors(response) {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  function requestContainsToolOutput(request) {
    const input = JSON.stringify(request.input ?? [])
    return input.includes('function_call_output') || input.includes('custom_tool_call_output')
  }

  function requestAdvertisesShellTool(request) {
    const tools = Array.isArray(request.tools) ? request.tools : []
    return tools.some(tool => tool?.name === 'exec_command' || tool?.name === 'shell_command')
  }

  function selectTool(request, name, argumentsValue) {
    const tools = Array.isArray(request.tools) ? request.tools : []
    const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
    assert.ok(names.has(name), `Real Codex did not advertise ${name}: ${[...names].join(', ')}`)
    return { name, arguments: argumentsValue }
  }

  function selectShellTool(request, workspacePath) {
    const command = 'pwd'
    const tools = Array.isArray(request.tools) ? request.tools : []
    if (tools.some(tool => tool?.name === 'exec_command')) {
      return selectTool(request, 'exec_command', {
        cmd: command,
        workdir: workspacePath,
        yield_time_ms: 1000,
      })
    }
    if (tools.some(tool => tool?.name === 'shell_command')) {
      return selectTool(request, 'shell_command', {
        command,
        workdir: workspacePath,
        timeout_ms: 10_000,
      })
    }
    throw new Error('Real Codex did not advertise a supported shell tool')
  }

  function selectApplyPatchTool(request) {
    const tools = Array.isArray(request.tools) ? request.tools : []
    assert.ok(
      tools.some(tool => tool?.name === 'apply_patch'),
      `Real Codex did not advertise apply_patch: ${tools
        .map(tool => tool?.name)
        .filter(Boolean)
        .join(', ')}`
    )
    return [
      '*** Begin Patch',
      `*** Add File: ${ARTIFACT_NAME}`,
      `+${ARTIFACT_CONTENT}`,
      '*** End Patch',
    ].join('\n')
  }

  function selectCloudApplyPatchTool(request) {
    const tools = Array.isArray(request.tools) ? request.tools : []
    const applyPatch = tools.find(tool => tool?.name === 'apply_patch')
    assert.ok(applyPatch, 'Real cloud Codex did not advertise apply_patch')
    assert.equal(
      applyPatch.type,
      'custom',
      'Native Responses cloud models must preserve Codex custom tools'
    )
    return [
      '*** Begin Patch',
      `*** Add File: ${CLOUD_ARTIFACT_NAME}`,
      `+${CLOUD_ARTIFACT_CONTENT}`,
      '*** End Patch',
    ].join('\n')
  }

  function selectViewImageTool(request, workspacePath) {
    return selectTool(request, 'view_image', {
      path: join(workspacePath, IMAGE_ARTIFACT_NAME),
    })
  }

  return {
    createSse,
    codexRequestKind,
    responseCreated,
    responseCompleted,
    responseFailed,
    functionCall,
    customToolCall,
    assistantMessage,
    streamingMarkdownReport,
    streamingTextEvents,
    localProtocolCase,
    localProtocolPrompt,
    localProtocolArtifact,
    localProtocolArtifactContent,
    localProtocolPatch,
    localModelSwitchCommand,
    matrixCaseId,
    matrixTextPrompt,
    matrixTextCompletion,
    matrixToolPrompt,
    matrixToolCompletion,
    matrixArtifact,
    matrixArtifactContent,
    matrixPatch,
    readRequestBody,
    json,
    cors,
    requestContainsToolOutput,
    requestAdvertisesShellTool,
    selectTool,
    selectShellTool,
    selectApplyPatchTool,
    selectCloudApplyPatchTool,
    selectViewImageTool,
  }
}
