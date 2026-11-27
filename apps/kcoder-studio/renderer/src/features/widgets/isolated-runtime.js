/* Runs only after the native owner has verified a distinct sandboxed renderer. */
/* global createWidgetDrawingReadiness */
(() => {
  'use strict'
  const root = document.getElementById('widget-root')
  const nativeQuery = Document.prototype.querySelectorAll
  const nativeApply = Reflect.apply
  const widthGetter = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get
  const heightGetter = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get
  const nativeInterval = setInterval
  const nativePost = parent.postMessage.bind(parent)
  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  const nativeContextCanvas = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'canvas').get
  const contexts = new Set()
  const nativeCanvasPrototype = HTMLCanvasElement.prototype
  const nativeAttrPrototype = Attr.prototype
  const nativeAttrValue = Object.getOwnPropertyDescriptor(Attr.prototype, 'value')
  const nativeAttrName = Object.getOwnPropertyDescriptor(Attr.prototype, 'name').get
  const nativeSetEach = Set.prototype.forEach
  const nativeNumber = Number, nativeFinite = Number.isFinite, nativeTrunc = Math.trunc
  const nativeString = String, nativeLowercase = String.prototype.toLowerCase
  const nativeIsPrototypeOf = Object.prototype.isPrototypeOf
  const isCanvas = element => element && nativeApply(nativeIsPrototypeOf, nativeCanvasPrototype, [element])
  const checkCanvas = canvas => {
    const width = nativeApply(widthGetter, canvas, []), height = nativeApply(heightGetter, canvas, [])
    if (width * height > 4194304) throw new Error('widget_quota: canvas exceeds the pixel budget')
    let total = 0
    nativeApply(nativeSetEach, contexts, [item => { total += nativeApply(widthGetter, item, []) * nativeApply(heightGetter, item, []) }])
    if (total > 4194304) throw new Error('widget_quota: canvases exceed the total pixel budget')
  }
  const checkedDimension = (canvas, name, value) => {
    const number = nativeNumber(value)
    if (!nativeFinite(number) || number < 0 || number > 4194304) throw new Error('widget_quota: canvas dimension exceeds its budget')
    const dimension = nativeTrunc(number)
    const width = name === 'width' ? dimension : nativeApply(widthGetter, canvas, [])
    const height = name === 'height' ? dimension : nativeApply(heightGetter, canvas, [])
    if (width * height > 4194304) throw new Error('widget_quota: canvas resize exceeds the pixel budget')
    let total = width * height
    nativeApply(nativeSetEach, contexts, [item => { if (item !== canvas) total += nativeApply(widthGetter, item, []) * nativeApply(heightGetter, item, []) }])
    if (total > 4194304) throw new Error('widget_quota: canvas resize exceeds the total pixel budget')
    return dimension
  }
  // Guard common dimension writes before the browser reallocates an existing 2D backing store.
  for (const name of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name)
    Object.defineProperty(HTMLCanvasElement.prototype, name, { ...descriptor, configurable: false, set(value) { nativeApply(descriptor.set, this, [checkedDimension(this, name, value)]) } })
  }
  const checkAttribute = (element, name, value) => {
    if (!isCanvas(element)) return value
    const key = nativeApply(nativeLowercase, nativeString(name), [])
    return key === 'width' || key === 'height' ? nativeString(checkedDimension(element, key, value)) : value
  }
  const checkAttributeNode = (element, attribute) => {
    if (!isCanvas(element)) return
    const value = nativeApply(nativeAttrValue.get, attribute, [])
    const checked = checkAttribute(element, nativeApply(nativeAttrName, attribute, []), value)
    if (checked !== value) nativeApply(nativeAttrValue.set, attribute, [checked])
  }
  for (const name of ['setAttribute', 'setAttributeNS', 'setAttributeNode', 'setAttributeNodeNS']) {
    const native = Element.prototype[name]
    Object.defineProperty(Element.prototype, name, { configurable: false, writable: false, value: function (...args) {
      if (name === 'setAttributeNode' || name === 'setAttributeNodeNS') checkAttributeNode(this, args[0])
      else { const offset = name === 'setAttributeNS' ? 1 : 0; args[offset + 1] = checkAttribute(this, args[offset], args[offset + 1]) }
      return nativeApply(native, this, args)
    } })
  }
  for (const [prototype, name] of [[Attr.prototype, 'value'], [Node.prototype, 'nodeValue'], [Node.prototype, 'textContent']]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    Object.defineProperty(prototype, name, { ...descriptor, configurable: false, set(value) {
      const checked = nativeApply(nativeIsPrototypeOf, nativeAttrPrototype, [this]) ? checkAttribute(this.ownerElement, nativeApply(nativeAttrName, this, []), value) : value
      nativeApply(descriptor.set, this, [checked])
    } })
  }
  const attributeOwners = new WeakMap()
  const attributes = Object.getOwnPropertyDescriptor(Element.prototype, 'attributes')
  Object.defineProperty(Element.prototype, 'attributes', { ...attributes, configurable: false, get() {
    const map = nativeApply(attributes.get, this, [])
    if (isCanvas(this)) attributeOwners.set(map, this)
    return map
  } })
  for (const name of ['setNamedItem', 'setNamedItemNS']) {
    const native = NamedNodeMap.prototype[name]
    Object.defineProperty(NamedNodeMap.prototype, name, { configurable: false, writable: false, value: function (attribute) {
      checkAttributeNode(attributeOwners.get(this), attribute)
      return nativeApply(native, this, [attribute])
    } })
  }
  // GPU/worker APIs are outside this document's declared 2D office-visualization capability.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: false, writable: false, value: function (type, ...args) {
    if (String(type) !== '2d') throw new Error('resource_blocked: only Canvas 2D is enabled in this widget host')
    if (!contexts.has(this) && contexts.size >= 16) throw new Error('widget_quota: too many canvas contexts')
    contexts.add(this); checkCanvas(this)
    return nativeApply(nativeGetContext, this, ['2d', ...args])
  } })
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: false, writable: false, value: function () { throw new Error('resource_blocked: offscreen GPU/worker canvases are unavailable') } })
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(CanvasRenderingContext2D.prototype))) {
    if (typeof descriptor.value !== 'function' || name === 'constructor') continue
    Object.defineProperty(CanvasRenderingContext2D.prototype, name, { ...descriptor, configurable: false, writable: false, value: function (...args) {
      checkCanvas(nativeApply(nativeContextCanvas, this, []))
      return nativeApply(descriptor.value, this, args)
    } })
  }
  if ('OffscreenCanvas' in window) Object.defineProperty(window, 'OffscreenCanvas', { configurable: false, writable: false, value: undefined })
  if ('gpu' in Navigator.prototype) Object.defineProperty(Navigator.prototype, 'gpu', { configurable: false, get: () => undefined })
  let channel
  let savedState = {}
  let ready = false
  let runtimeErrors = 0
  const themeListeners = new Set()
  const send = (type, payload = {}) => {
    if (channel) nativePost({ protocol: 'kcoder-widget', version: 1, token: channel.token, widgetId: channel.widgetId, revision: channel.revision, type, payload }, channel.parentOrigin)
  }
  const fail = error => send('error', { message: String(error?.message || error).slice(0, 2048) })
  const bytes = value => new TextEncoder().encode(value).byteLength
  const clone = value => JSON.parse(JSON.stringify(value))
  function validJson(value, depth = 0) {
    if (depth > 16) return false
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.length <= 1024 && value.every(item => validJson(item, depth + 1))
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
    return Object.entries(value).length <= 256 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && validJson(item, depth + 1))
  }
  Object.defineProperty(window, 'kworker', { writable: false, configurable: false, value: Object.freeze({
    sendPrompt(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Invalid follow-up draft')
      send('sendPrompt', { text })
    },
    getState: () => clone(savedState),
    setState(value) {
      if (!validJson(value) || bytes(JSON.stringify(value)) > 16384) throw new Error('Widget control state exceeds the JSON budget')
      savedState = clone(value)
      send('state', { state: savedState })
    },
    onTheme(callback) {
      if (typeof callback !== 'function' || themeListeners.size >= 8) throw new Error('Invalid widget theme listener')
      themeListeners.add(callback)
      return () => themeListeners.delete(callback)
    },
  }) })

  function theme(value) {
    if (!value || typeof value !== 'object') return
    document.documentElement.lang = value.locale || 'en'
    document.documentElement.style.colorScheme = value.colorScheme === 'dark' ? 'dark' : 'light'
    document.documentElement.dataset.reducedMotion = String(Boolean(value.reducedMotion))
    for (const [key, variable] of Object.entries({ foreground: '--foreground', background: '--background', muted: '--muted', border: '--border', primary: '--primary', success: '--success', destructive: '--destructive', fontFamily: '--font-ui', fontSize: '--text-base' })) {
      if (typeof value[key] === 'string' && value[key].length < 256) document.documentElement.style.setProperty(variable, value[key])
    }
    if (globalThis.Chart) {
      globalThis.Chart.defaults.color = value.foreground
      globalThis.Chart.defaults.borderColor = value.border
      globalThis.Chart.defaults.font.family = value.fontFamily
      globalThis.Chart.defaults.font.size = parseFloat(value.fontSize) || 14
      for (const chart of Object.values(globalThis.Chart.instances)) chart.update('none')
    }
    for (const callback of themeListeners) { try { callback(clone(value)) } catch (error) { fail(error) } }
  }
  function heartbeat() {
    const nodes = nativeApply(nativeQuery, document, ['*'])
    const canvases = nativeApply(nativeQuery, document, ['canvas'])
    let canvasPixels = 0
    for (const canvas of canvases) canvasPixels += nativeApply(widthGetter, canvas, []) * nativeApply(heightGetter, canvas, [])
    send('heartbeat', { domNodes: nodes.length, canvasPixels, ready })
    if (nodes.length > 4000 || canvasPixels > 4194304) {
      fail(new Error('widget_quota: component exceeded its DOM or canvas budget'))
    }
    send('resize', { height: Math.max(120, Math.ceil(root.getBoundingClientRect().height), root.scrollHeight) })
  }

  async function initialize(message) {
    if (message.executionMode !== 'isolated_html' || bytes(message.source) > 1048576) throw new Error('Invalid isolated widget document')
    if (validJson(message.state) && bytes(JSON.stringify(message.state)) <= 16384) savedState = clone(message.state)
    theme(message.theme)
    for (const id of ['chartjs', 'd3', 'topojson']) {
      if (typeof message.librarySources?.[id] !== 'string') continue
      const script = document.createElement('script'); script.textContent = message.librarySources[id]; document.head.append(script)
    }
    theme(message.theme)
    const drawing = createWidgetDrawingReadiness({ root, Chart: globalThis.Chart, required: typeof message.librarySources?.chartjs === 'string', locale: () => channel.theme.locale })
    const parsed = new DOMParser().parseFromString(`<body>${message.source}</body>`, 'text/html')
    if (parsed.querySelectorAll('*').length > 4000) throw new Error('widget_quota: too many DOM nodes')
    for (const element of parsed.querySelectorAll('base,meta,iframe,frame,object,embed,link')) element.remove()
    const scripts = [...parsed.querySelectorAll('script')]
    if (scripts.length > 32 || scripts.some(script => script.hasAttribute('src'))) throw new Error('resource_blocked: isolated widgets require self-contained scripts')
    root.replaceChildren(...parsed.body.childNodes)
    nativeInterval(heartbeat, 200)
    for (const original of scripts) {
      const type = original.getAttribute('type') || ''
      if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue
      const script = document.createElement('script')
      if (type) script.type = type
      script.textContent = original.textContent
      const completion = type === 'module' ? new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('Isolated module failed to load')) }) : Promise.resolve()
      original.replaceWith(script)
      await completion
    }
    const confirmed = await drawing.waitUntilReady()
    if (runtimeErrors > 0) throw new Error('render_failed: widget JavaScript raised an error before its first frame')
    if (!confirmed) { heartbeat(); send('unconfirmed'); return }
    ready = true
    heartbeat()
    send('ready')
  }
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return
    const message = event.data
    if (message.protocol !== 'kcoder-widget-host' || message.version !== 1) return
    if (message.type === 'init' && !channel) {
      if (typeof message.token !== 'string' || message.token.length < 24 || typeof message.widgetId !== 'string' || !Number.isSafeInteger(message.revision) || typeof message.source !== 'string') return
      channel = { token: message.token, widgetId: message.widgetId, revision: message.revision, parentOrigin: event.origin }
      initialize(message).catch(fail)
    } else if (channel && message.token === channel.token && message.widgetId === channel.widgetId && message.revision === channel.revision && message.type === 'theme') theme(message.theme)
  })
  addEventListener('error', event => { runtimeErrors += 1; fail(event.error || event.message) })
  addEventListener('unhandledrejection', event => { runtimeErrors += 1; fail(event.reason) })
})()
