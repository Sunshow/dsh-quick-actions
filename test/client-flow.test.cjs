/**
 * Dependency-free smoke test for the browser half.
 *
 * `client.js` is a lazy-CJS factory for the DSH module table, so this file
 * rebuilds the smallest possible host around it: a window that records
 * listeners, a document, and React stubs whose hooks never render. The palette
 * component is called directly only to read the state it projects -- nothing
 * here draws a UI or replaces the browser.
 *
 * What it covers, through the real source file:
 *   - the default Mod+Shift+N stroke opens the palette and takes the keyboard;
 *   - typing, composition, caret movement and the platform's editing strokes stay
 *     with the field, so an active input method is neither bypassed nor doubled;
 *   - the palette still owns its navigation strokes and hides every stroke from
 *     the app's shortcut layer;
 *   - ranking filters and orders workspaces (prefix > infix > subsequence, title > name > path);
 *   - Enter opens the highlighted workspace and reports completion only afterwards;
 *   - Escape closes and releases the keyboard;
 *   - a binding the user recorded outranks a newly added default;
 *   - both fixed layers are mounted on document.body, above body-portalled dialogs.
 *
 * Run with: node test/client-flow.test.cjs
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(SOURCE, 'utf8')

const BINDINGS_KEY = 'dsh.quick-actions.bindings.v1'

const CATALOG = {
  version: 1,
  platform: 'darwin',
  groups: [{ id: 'session', order: 20, title: { zh: '会话与界面', en: 'Session & layout' } }],
  actions: [
    {
      id: 'session.newInWorkspace',
      group: 'session',
      order: 5,
      target: 'client',
      clientAction: 'session.newInWorkspace',
      title: { zh: '在指定工作区新建会话', en: 'New session in a workspace' },
      hint: { zh: '', en: '' },
      commandLabel: '',
      defaultShortcut: { mac: 'Mod+Shift+N', other: 'Mod+Shift+N' },
    },
    {
      id: 'session.new',
      group: 'session',
      order: 10,
      target: 'client',
      clientAction: 'session.new',
      title: { zh: '新建会话', en: 'New session' },
      hint: { zh: '', en: '' },
      commandLabel: '',
      defaultShortcut: { mac: '', other: '' },
    },
  ],
  workspaces: [],
}

const WORKSPACES = [
  { workspaceId: 'w-quick', title: 'dsh-quick-actions', path: '/Volumes/External/GIT/sunshow/dsh-quick-actions', sessionIds: ['s1'] },
  { workspaceId: 'w-dsh', title: 'dsh', path: '/Volumes/External/GIT/sunshow/dsh', sessionIds: [] },
  { workspaceId: 'w-seller', title: 'seller-fe-admin', path: '/Volumes/External/GIT/mamba/seller/seller-fe-admin', sessionIds: [] },
  { workspaceId: 'w-default', title: 'default-workspace', path: '/Users/tester/Documents/deepseek-harness/default-workspace', sessionIds: [] },
]

/* -------------------------------------------------------------------- host */

/**
 * Boot the plugin against a throwaway host.
 * @param seed overrides written to localStorage before the plugin reads them.
 */
function boot(seed = {}) {
  let capturedFactory = null
  const listeners = { keydown: [] }
  const portals = []

  const fakeWindow = {
    __ModuleLoader__: {
      load(module) {
        capturedFactory = module
      },
    },
    addEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).concat(handler)
    },
    removeEventListener() {},
    setTimeout(handler, delay) {
      return setTimeout(handler, typeof delay === 'number' ? delay : 0)
    },
    clearTimeout(handle) {
      clearTimeout(handle)
    },
    localStorage: {
      store: Object.keys(seed).length === 0 ? {} : { [BINDINGS_KEY]: JSON.stringify(seed) },
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null
      },
      setItem(key, value) {
        this.store[key] = String(value)
      },
      removeItem(key) {
        delete this.store[key]
      },
    },
    innerWidth: 1280,
    innerHeight: 900,
    fetch: async () => ({ ok: true, json: async () => CATALOG }),
  }

  // The handler looks the search field up by its class, exactly as it does in
  // the page; this stub stands in for the real input element.
  const fieldElement = {
    tagName: 'INPUT',
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    },
    dispatchEvent() {},
  }

  const fakeDocument = {
    activeElement: { tagName: 'DIV', focus() {} },
    body: { tagName: 'BODY', portalHost: true },
    head: { appendChild() {} },
    createElement() {
      return { setAttribute() {}, textContent: '', remove() {} }
    },
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return true
    },
    querySelector(selector) {
      return selector === '.qa-palette__input' ? fieldElement : null
    },
    querySelectorAll() {
      return []
    },
  }

  const hookStub = (name) => (...args) => {
    if (name === 'useRef') return { current: null }
    if (name === 'useState') return [args[0], () => {}]
    if (name === 'useMemo' || name === 'useCallback') return typeof args[0] === 'function' ? args[0]() : undefined
    // Reading a store is exactly what the component does on mount.
    if (name === 'useSyncExternalStore') return typeof args[1] === 'function' ? args[1]() : undefined
    return undefined
  }

  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: hookStub('useCallback'),
    useEffect: hookStub('useEffect'),
    useMemo: hookStub('useMemo'),
    useRef: hookStub('useRef'),
    useState: hookStub('useState'),
    useSyncExternalStore: hookStub('useSyncExternalStore'),
    __isStub: true,
  }

  // `createPortal` stays transparent but records its container.
  const ReactDOMStub = {
    createPortal(element, container) {
      portals.push(container)
      return element
    },
  }

  const opened = []
  const workspaceSnapshot = {
    items: WORKSPACES,
    phase: 'ready',
    state: 'idle',
    error: null,
    archivedSessionIds: [],
    pinnedSessionIds: [],
  }

  const services = {
    locale: { bind: () => (key) => key, register() {}, getSnapshot: () => ({ active: 'zh' }) },
    sessions: {
      list: {
        getSnapshot: () => ({
          current: 's1',
          byId: { s1: { id: 's1', cwd: WORKSPACES[0].path, retainedBy: { mainView: 1 } } },
        }),
      },
    },
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } },
    uiWorkspace: {
      async openWorkspace(workspaceId) {
        opened.push(['open', workspaceId])
      },
      startSession(workspaceId) {
        opened.push(['start', workspaceId])
      },
    },
    layout: { toggleSidebar() {} },
  }

  const registered = []
  const fakeCtx = {
    get: (key) => services[key],
    effect: (callback) => callback(),
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return { options, component }
      },
    },
  }

  const load = new Function('window', 'document', 'navigator', 'require', source)
  load(fakeWindow, fakeDocument, { platform: 'MacIntel' }, (name) => {
    if (name === 'react') return ReactStub
    if (name === 'react-dom') return ReactDOMStub
    throw new Error('unexpected require: ' + name)
  })

  const factory = capturedFactory.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === 'react-dom') return ReactDOMStub
    throw new Error('unexpected require: ' + name)
  })
  factory.apply(fakeCtx)

  const picker = registered.filter((entry) => entry.options.id === 'quick-actions.workspace-picker')[0]
  const notice = registered.filter((entry) => entry.options.id === 'quick-actions.notice')[0]

  function press(init) {
    const event = {
      key: init.key,
      code: init.code || '',
      keyCode: typeof init.keyCode === 'number' ? init.keyCode : 0,
      metaKey: init.meta === true,
      ctrlKey: init.ctrl === true,
      altKey: init.alt === true,
      shiftKey: init.shift === true,
      repeat: init.repeat === true,
      isComposing: init.composing === true,
      target: init.target || { tagName: 'DIV' },
      defaultPrevented: false,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true
        this.prevented = true
      },
      stopPropagation() {
        this.stopped = true
      },
    }
    listeners.keydown.forEach((handler) => handler(event))
    return event
  }

  function collect(node, predicate, found = []) {
    if (!node || typeof node !== 'object') return found
    if (Array.isArray(node)) {
      node.forEach((child) => collect(child, predicate, found))
      return found
    }
    if (predicate(node)) found.push(node)
    const children = Array.isArray(node.children) ? node.children : []
    children.forEach((child) => collect(child, predicate, found))
    return found
  }

  /** Project what the palette would render right now. */
  function palette() {
    const tree = picker.component()
    if (!tree) return { open: false, query: '', rows: [], active: -1 }
    const input = collect(tree, (node) => node.type === 'input')[0]
    const options = collect(tree, (node) => node.props && node.props.role === 'option')
    const rows = options.map((row) => {
      const label = collect(row, (node) => node.type === 'span')[0]
      return (label && label.children && label.children[0]) || ''
    })
    const active = options.findIndex((row) => String(row.props['aria-selected']) === 'true')
    return { open: true, query: input ? input.props.value : '', rows, active, tree }
  }

  /** What the browser does when the field's value changes. */
  function field(value) {
    fieldElement.value = value
    fieldElement.selectionStart = value.length
    fieldElement.selectionEnd = value.length
    const input = collect(palette().tree, (node) => node.type === 'input')[0]
    if (!input) throw new Error('the palette field is not rendered')
    input.props.onChange({ target: { value } })
  }

  /**
   * Type at the end of the field the way the browser does: a keydown that the
   * page may cancel, then an input event carrying the resulting value. The
   * palette must not add the character on its own.
   */
  function type(text) {
    Array.from(text).forEach((character) => {
      const letter = /^[a-z]$/i.test(character)
      const event = press({ key: character, code: letter ? 'Key' + character.toUpperCase() : '' })
      if (event.prevented) return
      field(palette().query + character)
    })
  }

  /** Latest toast the notice layer would show. */
  function toast() {
    const tree = notice.component()
    if (!tree) return null
    const title = collect(tree, (node) => node.type === 'span' && /qa-notice__title/.test(String(node.props && node.props.className)))[0]
    const detail = collect(tree, (node) => node.type === 'pre')[0]
    return {
      title: title ? title.children[0] : '',
      detail: detail ? detail.children[0] : '',
      kind: String(collect(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('qa-notice--') !== -1)[0].props.className).replace('qa-notice qa-notice--', ''),
    }
  }

  return { press, field, type, palette, toast, opened, portals, registered, picker, fieldElement, noticeTree: () => notice.component() }
}

/* -------------------------------------------------------------------- checks */

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  const suffix = ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(actual)}${suffix}`)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const stroke = { key: 'N', code: 'KeyN', meta: true, shift: true }

;(async () => {
  const app = boot()
  await tick() // let the catalog fetch settle

  check('all plugin slots registered', app.registered.map((entry) => `${entry.options.name}#${entry.options.id}`).sort(), [
    'conversation.input.left#quick-actions.trigger',
    'settings.section#quick-actions',
    'settings.section.icon#quick-actions',
    'shell.overlay#quick-actions.menu',
    'shell.overlay#quick-actions.notice',
    'shell.overlay#quick-actions.workspace-picker',
  ])

  check('plain typing is left to the page', app.press({ key: 'd' }).defaultPrevented, false)
  check('the default stroke is consumed', app.press(stroke).defaultPrevented, true)
  check('the palette opened on it', app.palette().open, true)
  check('both fixed layers are portalled', app.portals.length >= 1, true)
  check('every workspace is listed', app.palette().rows.length, WORKSPACES.length)
  check('the automatic default workspace reads as a name', app.palette().rows.indexOf('默认工作区') >= 0, true)

  // Typing belongs to the field: the palette neither cancels the stroke nor
  // adds the character itself, so an active input method cannot double it.
  const typedKey = app.press({ key: 'd' })
  check('typing is not cancelled', typedKey.prevented, false)
  check('typing is kept from the app shortcuts', typedKey.stopped, true)
  app.field('d')
  app.type('sh')
  check('the query follows the typed text', app.palette().query, 'dsh')
  check('an exact title outranks a longer prefix', app.palette().rows, ['dsh', 'dsh-quick-actions'])

  // An input method's strokes stay inside the composition; the committed text
  // reaches the field once, through its change event.
  const composing = app.press({ key: 'Process', code: 'KeyZ', composing: true })
  check('a composing stroke is not cancelled', composing.prevented, false)
  check('a composing stroke is kept from the app shortcuts', composing.stopped, true)
  app.field('中文')
  check('committed text is not doubled', app.palette().query, '中文')
  const composingEnter = app.press({ key: 'Enter', composing: true })
  check('Enter that picks a candidate is not cancelled', composingEnter.prevented, false)
  check('Enter that picks a candidate opens nothing', app.opened, [])
  const trailing229 = app.press({ key: 'Enter', keyCode: 229 })
  check('the 229 stroke after a composition is not cancelled', trailing229.prevented, false)
  check('the 229 stroke opens nothing either', app.opened, [])
  app.field('')

  // Editing and caret strokes are native too; only the app layer is kept out.
  const nativeStroke = (init) => {
    const event = app.press(init)
    return { prevented: event.prevented, stopped: event.stopped }
  }
  const native = { prevented: false, stopped: true }
  check('Backspace stays with the field', nativeStroke({ key: 'Backspace' }), native)
  check('Delete stays with the field', nativeStroke({ key: 'Delete' }), native)
  check('Left arrow stays with the field', nativeStroke({ key: 'ArrowLeft' }), native)
  check('Cmd-A (select all) stays with the field', nativeStroke({ key: 'a', meta: true }), native)
  check('paste stays with the field', nativeStroke({ key: 'v', meta: true }), native)

  // macOS text views move the caret with Ctrl-A/E/B/F and kill with Ctrl-K/U;
  // Chromium gives a page none of that, so the palette supplies it for its field.
  const paletteStroke = { prevented: true, stopped: true }
  app.field('abcd')
  check('Ctrl-A belongs to the palette on macOS', nativeStroke({ key: 'a', ctrl: true }), paletteStroke)
  check('Ctrl-A moves to the start of the line', app.fieldElement.selectionStart, 0)
  check('Ctrl-E belongs to the palette on macOS', nativeStroke({ key: 'e', ctrl: true }), paletteStroke)
  check('Ctrl-E moves to the end of the line', app.fieldElement.selectionStart, 4)
  nativeStroke({ key: 'b', ctrl: true })
  check('Ctrl-B steps one character back', app.fieldElement.selectionStart, 3)
  nativeStroke({ key: 'f', ctrl: true })
  check('Ctrl-F steps one character forward', app.fieldElement.selectionStart, 4)
  nativeStroke({ key: 'a', ctrl: true })
  nativeStroke({ key: 'k', ctrl: true })
  check('Ctrl-K kills to the end of the line', app.fieldElement.value, '')
  app.field('abcd')
  nativeStroke({ key: 'u', ctrl: true })
  check('Ctrl-U kills to the start of the line', app.fieldElement.value, '')
  app.field('abcd')
  nativeStroke({ key: 'a', ctrl: true })
  nativeStroke({ key: 'f', ctrl: true })
  nativeStroke({ key: 'f', ctrl: true })
  nativeStroke({ key: 'd', ctrl: true })
  check('Ctrl-D deletes forward', app.fieldElement.value, 'abd')
  nativeStroke({ key: 'h', ctrl: true })
  check('Ctrl-H deletes backward', app.fieldElement.value, 'ad')
  app.field('')

  // The palette keeps its navigation strokes, and Home/End no longer steal the
  // caret keys.
  app.field('dsh')
  check('ArrowDown moves the highlight', app.press({ key: 'ArrowDown' }).prevented, true)
  check('the second row is highlighted', app.palette().active, 1)
  check('Home is not cancelled', app.press({ key: 'Home' }).prevented, false)
  check('Home leaves the highlight alone', app.palette().active, 1)
  check('End is not cancelled', app.press({ key: 'End' }).prevented, false)
  check('End leaves the highlight alone', app.palette().active, 1)
  check('ArrowUp moves back', app.press({ key: 'ArrowUp' }).prevented, true)
  check('the first row is highlighted again', app.palette().active, 0)

  app.field('')
  check('PageDown pages five rows', app.press({ key: 'PageDown' }).prevented, true)
  check('the highlight is clamped to the last row', app.palette().active, WORKSPACES.length - 1)
  check('PageUp pages back', app.press({ key: 'PageUp' }).prevented, true)
  check('the highlight is back at the first row', app.palette().active, 0)
  check('Tab moves the highlight', app.press({ key: 'Tab' }).prevented, true)
  check('Shift-Tab moves it back', app.press({ key: 'Tab', shift: true }).prevented, true)
  check('the first row is highlighted again', app.palette().active, 0)

  // A native Backspace reports the shorter value; the query follows the field.
  app.field('dsh')
  app.press({ key: 'Backspace' })
  app.field('ds')
  check('a native Backspace shortens the query', app.palette().query, 'ds')
  app.type('h')
  app.press({ key: 'Enter' })
  await tick()
  check('Enter opened the highlighted workspace', app.opened, [['open', 'w-dsh']])
  check('the palette closed itself', app.palette().open, false)
  check('completion is reported after the open resolves', app.toast() && app.toast().title, '打开新会话 · dsh')
  check('typing is released after a pick', app.press({ key: 'd' }).defaultPrevented, false)

  app.press(stroke)
  app.type('dqa')
  check('a loose subsequence still finds the row', app.palette().rows, ['dsh-quick-actions'])
  app.press({ key: 'Escape' })
  check('Escape closes the palette', app.palette().open, false)
  check('Escape releases the keyboard', app.press({ key: 'd' }).defaultPrevented, false)

  app.press(stroke)
  app.type('sel')
  check('filtering by an infix drops the others', app.palette().rows, ['seller-fe-admin'])
  check('ArrowDown is consumed', app.press({ key: 'ArrowDown' }).defaultPrevented, true)
  check('a one-row list keeps its highlight', app.palette().active, 0)
  app.press({ key: 'Enter' })
  await tick()
  check('the highlighted row is the one that opened', app.opened[app.opened.length - 1], ['open', 'w-seller'])

  app.press(stroke)
  app.type('zzz')
  check('a query that matches nothing shows no rows', app.palette().rows, [])
  app.press({ key: 'Enter' })
  await tick()
  check('Enter on an empty result does nothing', app.opened.length, 2)
  app.press({ key: 'Escape' })
  check('Escape closes after a failed query', app.palette().open, false)

  check('a bare modifier is inert when closed', app.press({ key: 'Shift', shift: true }).defaultPrevented, false)

  // A stroke the user recorded earlier outranks the default the update added.
  const bound = boot({ 'session.new': 'Mod+Shift+N' })
  await tick()
  bound.press(stroke)
  await tick()
  check('a recorded binding wins over a new default', bound.opened, [['start', undefined]])
  check('the picker stayed closed in that case', bound.palette().open, false)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
