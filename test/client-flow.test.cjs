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
 *   - typed keys never reach the field, so an active input method cannot interfere;
 *   - an input method that consumed the character still contributes its physical key;
 *   - ranking filters and orders workspaces (prefix > infix > subsequence, title > name > path);
 *   - Enter opens the highlighted workspace and reports completion only afterwards;
 *   - Escape closes and releases the keyboard, paste passes through, select-all does not;
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
    querySelector() {
      return null
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

  return { press, palette, toast, opened, portals, registered, picker, noticeTree: () => notice.component() }
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

  check('typing never reaches the field', app.press({ key: 'd' }).defaultPrevented, true)
  app.press({ key: 's' })
  app.press({ key: 'h' })
  check('the query follows the keystrokes', app.palette().query, 'dsh')
  check('an exact title outranks a longer prefix', app.palette().rows, ['dsh', 'dsh-quick-actions'])

  // An input method that consumed the character still contributes its physical key.
  app.press({ key: 'Backspace' })
  app.press({ key: 'Backspace' })
  app.press({ key: 'Backspace' })
  app.press({ key: 'Process', code: 'KeyQ' })
  app.press({ key: 'Process', code: 'KeyA' })
  check('a consumed key falls back to its physical letter', app.palette().query, 'qa')

  app.press({ key: 'Backspace' })
  app.press({ key: 'Backspace' })
  app.press({ key: 'd' })
  app.press({ key: 's' })
  app.press({ key: 'h' })
  app.press({ key: 'Enter' })
  await tick()
  check('Enter opened the highlighted workspace', app.opened, [['open', 'w-dsh']])
  check('the palette closed itself', app.palette().open, false)
  check('completion is reported after the open resolves', app.toast() && app.toast().title, '打开新会话 · dsh')
  check('typing is released after a pick', app.press({ key: 'd' }).defaultPrevented, false)

  app.press(stroke)
  app.press({ key: 'd' })
  app.press({ key: 'q' })
  app.press({ key: 'a' })
  check('a loose subsequence still finds the row', app.palette().rows, ['dsh-quick-actions'])
  app.press({ key: 'Escape' })
  check('Escape closes the palette', app.palette().open, false)
  check('Escape releases the keyboard', app.press({ key: 'd' }).defaultPrevented, false)

  app.press(stroke)
  app.press({ key: 's' })
  app.press({ key: 'e' })
  app.press({ key: 'l' })
  check('filtering by an infix drops the others', app.palette().rows, ['seller-fe-admin'])
  check('ArrowDown is consumed', app.press({ key: 'ArrowDown' }).defaultPrevented, true)
  check('a one-row list keeps its highlight', app.palette().active, 0)
  app.press({ key: 'Enter' })
  await tick()
  check('the highlighted row is the one that opened', app.opened[app.opened.length - 1], ['open', 'w-seller'])

  app.press(stroke)
  app.press({ key: 'z' })
  app.press({ key: 'z' })
  app.press({ key: 'z' })
  check('a query that matches nothing shows no rows', app.palette().rows, [])
  app.press({ key: 'Enter' })
  await tick()
  check('Enter on an empty result does nothing', app.opened.length, 2)
  check('Backspace is consumed', app.press({ key: 'Backspace' }).defaultPrevented, true)
  app.press({ key: 'Backspace', meta: true })
  check('clearing restores every row', app.palette().rows.length, WORKSPACES.length)

  check('End moves to the last row', (app.press({ key: 'End' }), app.palette().active), WORKSPACES.length - 1)
  check('Home returns to the first row', (app.press({ key: 'Home' }), app.palette().active), 0)

  const paste = app.press({ key: 'v', meta: true })
  check('the paste stroke is left to the browser', paste.defaultPrevented, false)
  check('the paste stroke is kept from app shortcuts', paste.stopped, true)
  const selectAll = app.press({ key: 'a', meta: true })
  check('select-all stays inside the palette', selectAll.defaultPrevented, true)
  app.press({ key: 'Escape' })
  check('Escape closes after a paste stroke', app.palette().open, false)
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
