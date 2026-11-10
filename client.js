// Quick actions — browser half.
//
// Loaded by dsh-client-modules through the vendored lazy-CJS module table
// (window.__ModuleLoader__.load). Responsibilities:
//   - a window-wide keydown listener, active on the New Session screen and
//     during a session, that runs the configured action;
//   - a grouped settings page in the `settings.section` slot where shortcut
//     bindings are recorded, reset and persisted (localStorage);
//   - a transient notice in `shell.overlay` showing the command result.
//
// The Host half owns the action catalog and executes `host` actions in the
// current workspace directory over /api/quick-actions/*.

window.__ModuleLoader__.load({
  id: 'dsh-quick-actions',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const {
      useCallback,
      useEffect,
      useRef,
      useState,
    } = React;

    const useSyncExternalStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : function useStoreFallback(subscribe, getSnapshot) {
        const [value, setValue] = useState(getSnapshot);
        useEffect(() => {
          const read = () => setValue(getSnapshot);
          read();
          return subscribe(read);
        }, [subscribe, getSnapshot]);
        return value;
      };

    const NS = 'quick-actions';
    const STORAGE_KEY = 'dsh.quick-actions.bindings.v1';
    const LAST_WORKSPACE_KEY = 'dsh.quick-actions.last-workspace.v1';
    const FALLBACK_KEY = 'dsh.quick-actions.fallback-directory.v1';
    const CUSTOM_KEY = 'dsh.quick-actions.custom-actions.v1';
    const CUSTOM_GROUP = { id: 'custom', order: 30, title: { zh: '自定义命令', en: 'Custom commands' } };
    const CATALOG_URL = '/api/quick-actions/catalog';
    const RUN_URL = '/api/quick-actions/run';
    // Resolved notices dismiss themselves; a failure stays long enough to read.
    const NOTICE_TIMEOUT_OK_MS = 6000;
    const NOTICE_TIMEOUT_OK_SHORT_MS = 3200;
    const NOTICE_TIMEOUT_ERROR_MS = 12000;
    const NOTICE_TIMEOUT_PENDING_MS = 40000;

    const IS_MAC = (() => {
      try {
        const sources = [
          navigator.platform,
          navigator.userAgentData && navigator.userAgentData.platform,
          navigator.userAgent,
        ].filter(Boolean).join(' ');
        return /mac|iphone|ipad|ipod/i.test(String(sources));
      } catch (error) {
        return false;
      }
    })();

    /* ------------------------------------------------------------- locales */

    const DICTS = {
      zh: {
        'page.title': '快捷操作',
        'page.desc': '在任意界面（包括新会话页与会话进行中）按下快捷键即可执行操作；焦点在输入框内时不会触发。',
        'page.fallback.label': '回退目录',
        'page.fallback.none': '不设置（跟随 DSH 默认目录）',
        'page.fallback.hint': '快捷键始终在「当前工作区目录」执行；只有在无法识别当前工作区时（例如刚启动、还没打开任何会话），才使用这里选择的目录。',
        'custom.add': '添加自定义命令',
        'custom.namePlaceholder': '名称，例如：更新依赖',
        'custom.commandPlaceholder': '命令，例如：npm install && npm run build',
        'custom.save': '保存',
        'custom.cancel': '取消',
        'custom.edit': '编辑',
        'custom.delete': '删除',
        'custom.deleteConfirm': '确认删除？',
        'custom.warning': '自定义命令以当前用户身份在「当前工作区目录」中运行，Host 会校验目录；请只添加你自己确认过的命令。',
        'page.probe.label': '最近捕获按键',
        'page.probe.none': '尚未捕获到按键',
        'page.probe.hint': '在这里按一次组合键，可以确认页面是否真的收到了按键；若按下后没有任何变化，说明该组合被系统或浏览器占用，请换一个组合。',
        'page.probe.mods': '当前平台：Mod = {key}',
        'menu.title': '快捷操作',
        'menu.hint': '设置 → 快捷操作 可修改快捷键',
        'menu.runsIn': '执行目录',
        'page.resetAll': '全部恢复默认',
        'page.resetAll.done': '已恢复默认快捷键',
        'page.unbound': '未绑定',
        'page.recording': '按下按键…',
        'page.recording.tip': 'Esc 取消，Backspace 清除',
        'page.reset': '恢复默认',
        'page.record': '点击录制新的快捷键',
        'page.catalog.loading': '正在读取操作列表…',
        'page.catalog.error': '无法读取操作列表，请检查插件是否已启用',
        'page.footer.hint': '蓝色按键框可点击重新录制；浏览器占用的组合（例如新建标签页）不会被页面收到，请换用其他组合。',
        'notice.close': '关闭',
        'notice.running': '正在执行',
        'notice.ok': '已完成',
        'notice.error': '执行失败',
        'notice.conflict': '该组合原先绑定在“{name}”，已解除',
        'notice.noService': '当前界面不支持该操作',
        'notice.unknownAction': '未知的操作',
        'notice.done': '已执行',
      },
      en: {
        'page.title': 'Quick actions',
        'page.desc': 'Press a shortcut on any screen — the New Session page or a running session — to run an action. Shortcuts are ignored while typing in a text field.',
        'page.fallback.label': 'Fallback directory',
        'page.fallback.none': 'Not set (use the DSH default directory)',
        'page.fallback.hint': 'Shortcuts always run in the current workspace directory. This fallback is only used when no current workspace can be identified, for example right after start-up with no session open.',
        'custom.add': 'Add a custom command',
        'custom.namePlaceholder': 'Name, e.g. Update dependencies',
        'custom.commandPlaceholder': 'Command, e.g. npm install && npm run build',
        'custom.save': 'Save',
        'custom.cancel': 'Cancel',
        'custom.edit': 'Edit',
        'custom.delete': 'Delete',
        'custom.deleteConfirm': 'Delete?',
        'custom.warning': 'A custom command runs as your user in the current workspace directory (the Host validates the directory). Only add commands you trust.',
        'page.probe.label': 'Last key captured',
        'page.probe.none': 'No key captured yet',
        'page.probe.hint': 'Press a combination here to confirm the page receives it. If nothing changes, the system or browser owns that combination — pick another one.',
        'page.probe.mods': 'This platform: Mod = {key}',
        'menu.title': 'Quick actions',
        'menu.hint': 'Settings → Quick actions changes the shortcuts',
        'menu.runsIn': 'Runs in',
        'page.resetAll': 'Reset all to defaults',
        'page.resetAll.done': 'Shortcuts reset to defaults',
        'page.unbound': 'Unbound',
        'page.recording': 'Press keys…',
        'page.recording.tip': 'Esc cancels, Backspace clears',
        'page.reset': 'Reset to default',
        'page.record': 'Click to record a new shortcut',
        'page.catalog.loading': 'Loading actions…',
        'page.catalog.error': 'Could not load the action list; check that the plugin is enabled',
        'page.footer.hint': 'Click a shortcut chip to record a new combination. Combinations the browser reserves (for example New Tab) never reach the page — pick another one.',
        'notice.close': 'Dismiss',
        'notice.running': 'Running',
        'notice.ok': 'Done',
        'notice.error': 'Failed',
        'notice.conflict': 'That combination was bound to “{name}” and has been cleared',
        'notice.noService': 'This action is unavailable in the current view',
        'notice.unknownAction': 'Unknown action',
        'notice.done': 'Ran',
      },
    };

    const KEY_SYMBOLS_MAC = {
      Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
      Space: 'Space', Escape: 'Esc', Backspace: '⌫', Delete: '⌦',
      Enter: '↩', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    };
    const KEY_SYMBOLS_OTHER = {
      Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift',
      Space: 'Space', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Del',
      Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    };

    /* --------------------------------------------------------------- utils */

    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot() {
          return value;
        },
        subscribe(listener) {
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        },
        set(next) {
          value = next;
          listeners.forEach(function notify(listener) {
            try {
              listener();
            } catch (error) {
              /* keep the other subscribers alive */
            }
          });
        },
        patch(partial) {
          this.set(Object.assign({}, value, partial));
        },
      };
    }

    function readSnapshot(source) {
      if (source === null || source === undefined) return null;
      try {
        if (typeof source.getSnapshot === 'function') return source.getSnapshot();
        return source;
      } catch (error) {
        return null;
      }
    }

    function loadOverrides() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const clean = {};
        Object.keys(parsed).forEach(function keep(key) {
          if (typeof parsed[key] === 'string') clean[key] = parsed[key];
        });
        return clean;
      } catch (error) {
        return {};
      }
    }

    function loadCustomActions() {
      try {
        const raw = window.localStorage.getItem(CUSTOM_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(function usable(item) {
            return item && typeof item.id === 'string' && item.id !== ''
              && typeof item.name === 'string' && typeof item.command === 'string' && item.command.trim() !== '';
          })
          .slice(0, 50)
          .map(function normalize(item) {
            return { id: item.id, name: item.name, command: item.command };
          });
      } catch (error) {
        return [];
      }
    }

    function saveCustomActions(items) {
      try {
        window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(items));
      } catch (error) {
        /* the list then lasts for this page only */
      }
    }

    function mergeCatalog(catalog, customItems) {
      if (!catalog || !Array.isArray(catalog.actions)) return catalog;
      const items = Array.isArray(customItems) ? customItems : [];
      const customActions = items.map(function toAction(item, index) {
        return {
          id: item.id,
          group: CUSTOM_GROUP.id,
          order: 100 + index,
          target: 'custom',
          clientAction: '',
          title: { zh: item.name, en: item.name },
          hint: { zh: item.command, en: item.command },
          commandLabel: item.command,
          defaultShortcut: { mac: '', other: '' },
          custom: { command: item.command },
        };
      });
      const groups = catalog.groups.slice();
      if (groups.every(function notCustom(group) { return group.id !== CUSTOM_GROUP.id; })) {
        groups.push(CUSTOM_GROUP);
      }
      return {
        version: catalog.version,
        platform: catalog.platform,
        defaultDirectory: catalog.defaultDirectory,
        workspaces: catalog.workspaces,
        groups,
        actions: catalog.actions.concat(customActions),
      };
    }

    function saveOverrides(overrides) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
      } catch (error) {
        /* private mode or quota: bindings stay in memory for this page */
      }
    }

    function readFallbackDirectory() {
      try {
        return window.localStorage.getItem(FALLBACK_KEY) || '';
      } catch (error) {
        return '';
      }
    }

    function writeFallbackDirectory(path) {
      try {
        if (path) window.localStorage.setItem(FALLBACK_KEY, path);
        else window.localStorage.removeItem(FALLBACK_KEY);
      } catch (error) {
        /* private mode: the choice lasts for this page only */
      }
    }

    function readLastWorkspace() {
      try {
        return window.localStorage.getItem(LAST_WORKSPACE_KEY) || '';
      } catch (error) {
        return '';
      }
    }

    const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'OS', 'AltGraph']);

    function normalizeKeyName(event) {
      const raw = event.key;
      if (typeof raw !== 'string' || raw === '') return null;
      if (MODIFIER_KEYS.has(raw)) return null;
      if (raw === ' ') return 'Space';
      if (raw.length === 1) return raw.toUpperCase();
      return raw;
    }

    function shortcutFromEvent(event) {
      const key = normalizeKeyName(event);
      if (key === null) return null;
      const parts = [];
      if (IS_MAC ? event.metaKey : event.ctrlKey) parts.push('Mod');
      if (IS_MAC && event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');
      parts.push(key);
      return parts.join('+');
    }

    function tokenizeShortcut(shortcut) {
      if (typeof shortcut !== 'string' || shortcut === '') return [];
      return shortcut.split('+');
    }

    function symbolFor(token) {
      const table = IS_MAC ? KEY_SYMBOLS_MAC : KEY_SYMBOLS_OTHER;
      return table[token] || token;
    }

    function renderKeyIcon(size) {
      const px = typeof size === 'number' ? size : 16;
      return h('svg', {
        width: px,
        height: px,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('rect', { x: 2.5, y: 5.5, width: 19, height: 13, rx: 3.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M13.6 8.6 9.4 13.4h2.9l-1 3 4.3-5h-2.9z', fill: 'currentColor' }),
      );
    }

    function renderShortcutChips(shortcut, emptyText) {
      if (typeof shortcut !== 'string' || shortcut === '') {
        return h('span', { className: 'qa-key__unbound' }, emptyText);
      }
      return tokenizeShortcut(shortcut).map(function chip(token, index) {
        return h('kbd', { className: 'qa-kbd', key: token + index }, symbolFor(token));
      });
    }

    function describeProbe(probe) {
      if (!probe) return '';
      const flags = [
        (probe.meta ? '⌘' : '·'),
        (probe.ctrl ? '⌃' : '·'),
        (probe.alt ? '⌥' : '·'),
        (probe.shift ? '⇧' : '·'),
      ].join('');
      const where = probe.editable ? ' · field' : '';
      return 'key=' + probe.key + ' code=' + (probe.code || '?') + ' ' + flags + where;
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return '';
      const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
      const index = trimmed.lastIndexOf('/');
      return index === -1 ? trimmed : trimmed.slice(index + 1);
    }

    function isEditableTarget(target) {
      if (!target || typeof target !== 'object') return false;
      const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable === true) return true;
      return false;
    }

    function pickText(value, activeLocale) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      const lang = String(activeLocale || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      return value[lang] || value.en || value.zh || '';
    }

    function defaultShortcutOf(action) {
      if (!action || !action.defaultShortcut) return '';
      return IS_MAC ? action.defaultShortcut.mac || '' : action.defaultShortcut.other || '';
    }

    function effectiveShortcut(action, overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, action.id)) return overrides[action.id];
      return defaultShortcutOf(action);
    }

    function findActionByShortcut(actions, overrides, shortcut) {
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        if (effectiveShortcut(action, overrides) === shortcut) return action;
      }
      return null;
    }

    /* ------------------------------------------------------------- service */

    function apply(ctx) {
      const catalogStore = createStore({
        catalog: null,
        overrides: loadOverrides(),
        custom: loadCustomActions(),
        error: null,
      });
      const noticeStore = createStore(null);
      const menuStore = createStore({ open: false, anchor: null });
      const probeStore = createStore(null);

      let capturing = false;
      let noticeTimer = 0;
      let noticeSeq = 0;
      let lastKnownWorkspace = '';

      const locale = ctx.get('locale');
      const translate = (() => {
        if (locale && typeof locale.bind === 'function') {
          try {
            return locale.bind(NS);
          } catch (error) {
            /* fall through to the built-in dictionary */
          }
        }
        return function fallbackTranslate(key) {
          const dict = DICTS.zh;
          return dict[key] || key;
        };
      })();

      function activeLocaleId() {
        try {
          const snapshot = locale && (typeof locale.getSnapshot === 'function'
            ? locale.getSnapshot()
            : locale.getLocale());
          return (snapshot && snapshot.active) || 'zh';
        } catch (error) {
          return 'zh';
        }
      }

      function t(key, values) {
        let text = '';
        try {
          text = translate(key);
        } catch (error) {
          text = '';
        }
        if (typeof text !== 'string' || text === '' || text === key) {
          text = DICTS.zh[key] || key;
        }
        if (values) {
          Object.keys(values).forEach(function replace(token) {
            text = text.split('{' + token + '}').join(String(values[token]));
          });
        }
        return text;
      }

      function noticeLifetime(entry) {
        if (entry.kind === 'error') return NOTICE_TIMEOUT_ERROR_MS;
        if (entry.kind === 'pending') return NOTICE_TIMEOUT_PENDING_MS;
        return entry.detail ? NOTICE_TIMEOUT_OK_MS : NOTICE_TIMEOUT_OK_SHORT_MS;
      }

      function armNoticeTimer(seq, lifetime) {
        if (noticeTimer) {
          window.clearTimeout(noticeTimer);
          noticeTimer = 0;
        }
        if (lifetime <= 0) return;
        noticeTimer = window.setTimeout(function expire() {
          noticeTimer = 0;
          const current = noticeStore.getSnapshot();
          if (current && current.seq === seq) noticeStore.set(null);
        }, lifetime);
      }

      function notice(entry) {
        noticeSeq += 1;
        const next = Object.assign({ seq: noticeSeq }, entry);
        noticeStore.set(next);
        armNoticeTimer(next.seq, noticeLifetime(next));
      }

      // Hovering a notice pauses the countdown so the output can be read.
      function pauseNotice() {
        if (noticeTimer) {
          window.clearTimeout(noticeTimer);
          noticeTimer = 0;
        }
      }

      function resumeNotice() {
        const current = noticeStore.getSnapshot();
        if (current) armNoticeTimer(current.seq, noticeLifetime(current));
      }

      function dismissNotice() {
        if (noticeTimer) window.clearTimeout(noticeTimer);
        noticeTimer = 0;
        noticeStore.set(null);
      }

      function openMenu(anchor) {
        menuStore.set({ open: true, anchor: anchor || null });
      }

      function closeMenu() {
        const state = menuStore.getSnapshot();
        if (state && state.open) menuStore.set({ open: false, anchor: null });
      }

      /* ------------------------------------------------------ current place */

      function currentSessionId() {
        const sessions = ctx.get('sessions');
        const state = readSnapshot(sessions && sessions.list);
        if (!state) return null;
        if (typeof state.current === 'string' && state.current !== '') return state.current;
        const byId = state.byId;
        if (byId && typeof byId === 'object') {
          const ids = Object.keys(byId);
          for (let index = 0; index < ids.length; index += 1) {
            const row = byId[ids[index]];
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return ids[index];
          }
        }
        if (typeof state.active === 'string' && state.active !== '') return state.active;
        return null;
      }

      function rememberWorkspace(path) {
        if (typeof path !== 'string' || path === '') return;
        if (lastKnownWorkspace === path) return;
        lastKnownWorkspace = path;
        try {
          window.localStorage.setItem(LAST_WORKSPACE_KEY, path);
        } catch (error) {
          /* keep the in-memory mirror */
        }
      }

      function workspaceItems() {
        const workspaces = ctx.get('workspaces');
        const state = readSnapshot(workspaces && workspaces.list);
        if (!state) return { items: [], state: null };
        if (Array.isArray(state)) return { items: state, state: null };
        return { items: Array.isArray(state.items) ? state.items : [], state };
      }

      function currentWorkspacePath() {
        const { items, state } = workspaceItems();
        const sessionId = currentSessionId();

        if (sessionId) {
          for (let index = 0; index < items.length; index += 1) {
            const workspace = items[index];
            if (workspace && Array.isArray(workspace.sessionIds)
              && workspace.sessionIds.indexOf(sessionId) !== -1
              && typeof workspace.path === 'string' && workspace.path !== '') {
              rememberWorkspace(workspace.path);
              return workspace.path;
            }
          }
          const sessions = ctx.get('sessions');
          const sessionState = readSnapshot(sessions && sessions.list);
          const row = sessionState && sessionState.byId && sessionState.byId[sessionId];
          if (row && typeof row.cwd === 'string' && row.cwd !== '') {
            rememberWorkspace(row.cwd);
            return row.cwd;
          }
        }

        // No session on screen (blank New Session page): the host publishes no
        // "current workspace". An explicit fallback choice wins over the last
        // workspace the user was actually in.
        const preferred = readFallbackDirectory();
        if (preferred !== '') return preferred;
        const remembered = lastKnownWorkspace || readLastWorkspace();
        if (remembered !== '') return remembered;

        if (state && typeof state === 'object') {
          const keys = ['activeId', 'activeWorkspaceId', 'currentId', 'currentWorkspaceId', 'selectedId'];
          for (let index = 0; index < keys.length; index += 1) {
            const id = state[keys[index]];
            if (typeof id !== 'string' || id === '') continue;
            for (let inner = 0; inner < items.length; inner += 1) {
              const workspace = items[inner];
              if (workspace && (workspace.id === id || workspace.workspaceId === id) && typeof workspace.path === 'string') return workspace.path;
            }
          }
        }

        const paths = items
          .map(function pathOf(workspace) { return workspace && workspace.path; })
          .filter(function nonEmpty(path) { return typeof path === 'string' && path !== ''; });
        return paths.length === 1 ? paths[0] : null;
      }

      /* ------------------------------------------------------------ catalog */

      let catalogLoading = false;

      function loadCatalog() {
        if (catalogLoading) return;
        catalogLoading = true;
        window.fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
          .then(function parse(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function store(catalog) {
            catalogStore.patch({ catalog, error: null });
          })
          .catch(function fail(error) {
            catalogStore.patch({ error: String((error && error.message) || error) });
            window.setTimeout(function retry() {
              catalogLoading = false;
              if (catalogStore.getSnapshot().catalog === null) loadCatalog();
            }, 3000);
          })
          .then(function finish() {
            catalogLoading = false;
          });
      }

      /* --------------------------------------------------------- execution */

      function runClientAction(action) {
        const target = action.clientAction;
        if (target === 'session.new') {
          const uiWorkspace = ctx.get('uiWorkspace');
          if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            uiWorkspace.startSession();
            return { ok: true, output: '' };
          }
          return { ok: false, error: t('notice.noService') };
        }
        if (target === 'layout.toggleSidebar') {
          const layout = ctx.get('layout');
          if (layout && typeof layout.toggleSidebar === 'function') {
            layout.toggleSidebar();
            return { ok: true, output: '' };
          }
          return { ok: false, error: t('notice.noService') };
        }
        return { ok: false, error: t('notice.noService') };
      }

      let running = false;

      function runAction(action) {
        if (!action || running) return;
        closeMenu();
        const lang = activeLocaleId();
        const title = pickText(action.title, lang);
        running = true;

        if (action.target === 'client') {
          const result = runClientAction(action);
          running = false;
          notice({
            kind: result.ok ? 'ok' : 'error',
            title: result.ok ? t('notice.done') + ' · ' + title : title,
            detail: result.ok ? '' : result.error,
          });
          return;
        }

        notice({ kind: 'pending', title: t('notice.running') + ' · ' + title, detail: action.commandLabel || '' });

        window.fetch(RUN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            actionId: action.id,
            cwd: currentWorkspacePath() || undefined,
            custom: action.target === 'custom' && action.custom
              ? { command: action.custom.command }
              : undefined,
          }),
        })
          .then(function parse(response) {
            return response.json().then(function withBody(body) {
              if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status);
              return body;
            });
          })
          .then(function settle(payload) {
            if (payload && payload.ok) {
              notice({
                kind: 'ok',
                title: t('notice.ok') + ' · ' + title,
                detail: payload.output || '',
                meta: (payload.directory || '') + (payload.durationMs ? '  ·  ' + formatDuration(payload.durationMs) : ''),
              });
            } else {
              notice({
                kind: 'error',
                title: t('notice.error') + ' · ' + title,
                detail: (payload && (payload.error || payload.output)) || '',
                meta: payload && payload.directory ? payload.directory : '',
              });
            }
          })
          .catch(function fail(error) {
            notice({
              kind: 'error',
              title: t('notice.error') + ' · ' + title,
              detail: String((error && error.message) || error),
            });
          })
          .then(function release() {
            running = false;
          });
      }

      function formatDuration(ms) {
        if (ms < 1000) return ms + 'ms';
        return (ms / 1000).toFixed(1) + 's';
      }

      /* --------------------------------------------------------- listeners */

      ctx.effect(function installKeydown() {
        function onKeyDown(event) {
          if (capturing) return;
          if (event.isComposing || event.repeat) return;
          if (event.key === 'Escape') {
            closeMenu();
            return;
          }
          const shortcut = shortcutFromEvent(event);
          if (shortcut === null) return;

          // Diagnostics for the settings page: record what actually reached us,
          // before any guard can skip it.
          probeStore.set({
            shortcut,
            key: String(event.key),
            code: String(event.code || ''),
            meta: event.metaKey === true,
            ctrl: event.ctrlKey === true,
            alt: event.altKey === true,
            shift: event.shiftKey === true,
            editable: isEditableTarget(event.target),
          });

          const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
          // Plain typing belongs to the focused field; a modified combination is
          // a command even when the caret sits in the composer.
          if (!hasModifier && (event.defaultPrevented || isEditableTarget(event.target))) return;

          const snapshot = catalogStore.getSnapshot();
          const catalog = mergeCatalog(snapshot.catalog, snapshot.custom);
          if (!catalog || !Array.isArray(catalog.actions)) return;
          const action = findActionByShortcut(catalog.actions, snapshot.overrides, shortcut);
          if (!action) return;
          event.preventDefault();
          event.stopPropagation();
          runAction(action);
        }
        window.addEventListener('keydown', onKeyDown, true);
        return function removeKeydown() {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, 'quick-actions keydown');

      ctx.effect(function loadCatalogEffect() {
        loadCatalog();
        return function disposeCatalogLoader() {
          /* the fetch has no abortable owner beyond the page itself */
        };
      }, 'quick-actions catalog');

      /* -------------------------------------------------------------- style */

      ctx.effect(function insertStyles() {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-quick-actions');
        style.textContent = CSS;
        document.head.appendChild(style);
        return function removeStyles() {
          style.remove();
        };
      }, 'quick-actions styles');

      /* -------------------------------------------------------------- slots */

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'quick-actions.notice',
          order: 60,
        }, function NoticeOverlay() {
          const noticeState = useSyncExternalStore(noticeStore.subscribe, noticeStore.getSnapshot, noticeStore.getSnapshot);
          if (!noticeState) return null;
          const kind = noticeState.kind || 'ok';
          return h('div', { className: 'qa-notice-layer', 'aria-live': 'polite' },
            h('div', {
              className: 'qa-notice qa-notice--' + kind,
              role: 'status',
              onMouseEnter: pauseNotice,
              onMouseLeave: resumeNotice,
            },
              h('div', { className: 'qa-notice__head' },
                h('span', { className: 'qa-notice__dot', 'aria-hidden': true }),
                h('span', { className: 'qa-notice__title' }, noticeState.title || ''),
                h('button', {
                  type: 'button',
                  className: 'qa-notice__close',
                  'aria-label': t('notice.close'),
                  onClick: dismissNotice,
                }, '×'),
              ),
              noticeState.detail ? h('pre', { className: 'qa-notice__detail' }, noticeState.detail) : null,
              noticeState.meta ? h('div', { className: 'qa-notice__meta' }, noticeState.meta) : null,
            ),
          );
        });
      });

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'quick-actions',
          order: 47,
          label: function sectionLabel() {
            return t('page.title');
          },
        }, function QuickActionsSettings() {
          const state = useSyncExternalStore(catalogStore.subscribe, catalogStore.getSnapshot, catalogStore.getSnapshot);
          const probe = useSyncExternalStore(probeStore.subscribe, probeStore.getSnapshot, probeStore.getSnapshot);
          const [fallbackDirectory, setFallbackDirectory] = useState(readFallbackDirectory);
          const [recordingId, setRecordingId] = useState(null);
          const [draft, setDraft] = useState(null);
          const [pendingDelete, setPendingDelete] = useState(null);
          const localeId = activeLocaleId();

          useEffect(function syncCapturing() {
            capturing = recordingId !== null;
            return function releaseCapturing() {
              capturing = false;
            };
          }, [recordingId]);

          useEffect(function captureWhileRecording() {
            if (recordingId === null) return undefined;
            function onKeyDown(event) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                setRecordingId(null);
                return;
              }
              if (event.key === 'Backspace' || event.key === 'Delete') {
                setBinding(recordingId, '');
                setRecordingId(null);
                return;
              }
              const shortcut = shortcutFromEvent(event);
              if (shortcut === null) return;
              const catalog = catalogStore.getSnapshot().catalog;
              const conflicts = catalog && Array.isArray(catalog.actions)
                ? catalog.actions.filter(function other(candidate) {
                  return candidate.id !== recordingId
                    && effectiveShortcut(candidate, catalogStore.getSnapshot().overrides) === shortcut;
                })
                : [];
              conflicts.forEach(function clear(conflict) {
                setBinding(conflict.id, '', true);
              });
              setBinding(recordingId, shortcut, true);
              setRecordingId(null);
              if (conflicts.length > 0) {
                notice({
                  kind: 'ok',
                  title: t('notice.conflict', { name: pickText(conflicts[0].title, localeId) }),
                });
              }
            }
            window.addEventListener('keydown', onKeyDown, true);
            return function removeCapture() {
              window.removeEventListener('keydown', onKeyDown, true);
            };
          }, [recordingId, localeId]);

          function setBinding(actionId, shortcut, silent) {
            const current = catalogStore.getSnapshot();
            const next = Object.assign({}, current.overrides);
            if (shortcut === null) delete next[actionId];
            else next[actionId] = shortcut;
            saveOverrides(next);
            catalogStore.patch({ overrides: next });
            return silent ? undefined : null;
          }

          function upsertCustom(item) {
            const items = catalogStore.getSnapshot().custom.slice();
            const index = item.id === null
              ? -1
              : items.findIndex(function sameId(candidate) { return candidate.id === item.id; });
            const next = {
              id: item.id === null
                ? 'custom.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
                : item.id,
              name: item.name.trim(),
              command: item.command.trim(),
            };
            if (index === -1) items.push(next);
            else items[index] = next;
            saveCustomActions(items);
            catalogStore.patch({ custom: items });
            setDraft(null);
          }

          function removeCustom(actionId) {
            const items = catalogStore.getSnapshot().custom.filter(function other(item) {
              return item.id !== actionId;
            });
            saveCustomActions(items);
            const next = Object.assign({}, catalogStore.getSnapshot().overrides);
            delete next[actionId];
            saveOverrides(next);
            catalogStore.patch({ custom: items, overrides: next });
            setPendingDelete(null);
            setDraft(function clearDraft(current) {
              return current && current.id === actionId ? null : current;
            });
          }

          const catalog = mergeCatalog(state.catalog, state.custom);
          const overrides = state.overrides;

          if (!catalog) {
            return h('div', { className: 'qa-page' },
              h('h2', { className: 'qa-page__title' }, t('page.title')),
              h('p', { className: 'qa-page__desc' },
                state.error ? t('page.catalog.error') : t('page.catalog.loading')),
            );
          }

          const groups = Array.isArray(catalog.groups) ? catalog.groups.slice() : [];
          groups.sort(function byOrder(a, b) { return (a.order || 0) - (b.order || 0); });
          const actions = Array.isArray(catalog.actions) ? catalog.actions.slice() : [];
          actions.sort(function byOrder(a, b) { return (a.order || 0) - (b.order || 0); });

          const workspaceOptions = Array.isArray(catalog.workspaces) ? catalog.workspaces : [];

          return h('div', { className: 'qa-page' },
            h('h2', { className: 'qa-page__title' }, t('page.title')),
            h('p', { className: 'qa-page__desc' }, t('page.desc')),
            h('div', { className: 'qa-setting' },
              h('label', { className: 'qa-setting__label', htmlFor: 'qa-fallback' }, t('page.fallback.label')),
              h('select', {
                id: 'qa-fallback',
                className: 'qa-setting__select',
                value: fallbackDirectory,
                onChange: function chooseFallback(event) {
                  const next = event.target.value;
                  setFallbackDirectory(next);
                  writeFallbackDirectory(next);
                },
              },
                h('option', { value: '' }, t('page.fallback.none')),
                workspaceOptions.map(function renderOption(workspace) {
                  return h('option', { value: workspace.path, key: workspace.path }, workspace.title || workspace.path);
                }),
              ),
              h('p', { className: 'qa-setting__hint' }, t('page.fallback.hint')),
            ),
            h('div', { className: 'qa-probe' },
              h('span', { className: 'qa-probe__label' }, t('page.probe.label')),
              h('span', { className: 'qa-probe__value' },
                !probe
                  ? h('span', { className: 'qa-probe__idle' }, t('page.probe.none'))
                  : renderShortcutChips(probe.shortcut, t('page.probe.none'))),
              h('code', { className: 'qa-probe__raw', title: 'key / code / modifiers' },
                !probe ? '' : describeProbe(probe)),
            ),
            h('p', { className: 'qa-page__hint' },
              t('page.probe.hint') + ' ' + t('page.probe.mods', { key: IS_MAC ? '⌘' : 'Ctrl' }),
            ),
            groups.map(function renderGroup(group) {
              const groupActions = actions.filter(function inGroup(action) { return action.group === group.id; });
              if (groupActions.length === 0 && group.id !== CUSTOM_GROUP.id) return null;
              return h('section', { className: 'qa-group', key: group.id },
                h('h3', { className: 'qa-group__title' }, pickText(group.title, localeId)),
                h('div', { className: 'qa-group__rows' },
                  groupActions.map(function renderRow(action) {
                    const shortcut = effectiveShortcut(action, overrides);
                    const isRecording = recordingId === action.id;
                    return h('div', { className: 'qa-row', key: action.id },
                      h('div', { className: 'qa-row__text' },
                        h('span', { className: 'qa-row__title' }, pickText(action.title, localeId)),
                        h('span', { className: 'qa-row__hint' },
                          pickText(action.hint, localeId),
                          action.commandLabel ? h('code', { className: 'qa-row__cmd' }, action.commandLabel) : null,
                        ),
                      ),
                      h('div', { className: 'qa-row__controls' },
                        h('button', {
                          type: 'button',
                          className: 'qa-key' + (isRecording ? ' qa-key--recording' : '') + (shortcut === '' && !isRecording ? ' qa-key--unbound' : ''),
                          onClick: function startRecording() {
                            setRecordingId(isRecording ? null : action.id);
                          },
                          title: isRecording ? t('page.recording.tip') : t('page.record'),
                          'aria-label': t('page.title') + ': ' + pickText(action.title, localeId),
                        }, isRecording
                          ? h('span', { className: 'qa-key__recording' }, t('page.recording'))
                          : renderShortcutChips(shortcut, t('page.unbound'))),
                        h('button', {
                          type: 'button',
                          className: 'qa-reset',
                          title: t('page.reset'),
                          'aria-label': t('page.reset'),
                          disabled: !Object.prototype.hasOwnProperty.call(overrides, action.id),
                          onClick: function resetOne() {
                            setBinding(action.id, null);
                          },
                        }, '↺'),
                        action.target === 'custom' ? h('button', {
                          type: 'button',
                          className: 'qa-reset',
                          title: t('custom.edit'),
                          'aria-label': t('custom.edit'),
                          onClick: function editOne() {
                            setDraft({
                              id: action.id,
                              name: pickText(action.title, localeId),
                              command: action.commandLabel || '',
                            });
                          },
                        }, '✎') : null,
                        action.target === 'custom' ? h('button', {
                          type: 'button',
                          className: 'qa-reset qa-reset--danger' + (pendingDelete === action.id ? ' qa-reset--armed' : ''),
                          title: pendingDelete === action.id ? t('custom.deleteConfirm') : t('custom.delete'),
                          'aria-label': t('custom.delete'),
                          onClick: function deleteOne() {
                            if (pendingDelete === action.id) removeCustom(action.id);
                            else setPendingDelete(action.id);
                          },
                          onMouseLeave: function disarm() {
                            if (pendingDelete === action.id) setPendingDelete(null);
                          },
                        }, pendingDelete === action.id ? t('custom.deleteConfirm') : '✕') : null,
                      ),
                    );
                  }),
                ),
                group.id === CUSTOM_GROUP.id
                  ? (draft
                    ? h('div', { className: 'qa-form' },
                      h('input', {
                        className: 'qa-input',
                        placeholder: t('custom.namePlaceholder'),
                        value: draft.name,
                        autoFocus: true,
                        onChange: function editName(event) {
                          setDraft(Object.assign({}, draft, { name: event.target.value }));
                        },
                      }),
                      h('textarea', {
                        className: 'qa-input qa-textarea',
                        placeholder: t('custom.commandPlaceholder'),
                        rows: 3,
                        spellCheck: false,
                        value: draft.command,
                        onChange: function editCommand(event) {
                          setDraft(Object.assign({}, draft, { command: event.target.value }));
                        },
                      }),
                      h('p', { className: 'qa-form__note' }, t('custom.warning')),
                      h('div', { className: 'qa-form__actions' },
                        h('button', {
                          type: 'button',
                          className: 'qa-button qa-button--primary',
                          disabled: draft.name.trim() === '' || draft.command.trim() === '',
                          onClick: function saveDraftItem() {
                            upsertCustom(draft);
                          },
                        }, t('custom.save')),
                        h('button', {
                          type: 'button',
                          className: 'qa-button',
                          onClick: function cancelDraft() {
                            setDraft(null);
                          },
                        }, t('custom.cancel')),
                      ),
                    )
                    : h('button', {
                      type: 'button',
                      className: 'qa-add',
                      onClick: function startDraft() {
                        setDraft({ id: null, name: '', command: '' });
                      },
                    }, '+ ' + t('custom.add')))
                  : null,
              );
            }),
            h('footer', { className: 'qa-footer' },
              h('button', {
                type: 'button',
                className: 'qa-footer__button',
                onClick: function resetAll() {
                  saveOverrides({});
                  catalogStore.patch({ overrides: {} });
                  notice({ kind: 'ok', title: t('page.resetAll.done') });
                },
              }, t('page.resetAll')),
              h('p', { className: 'qa-footer__hint' }, t('page.footer.hint')),
            ),
          );
        });
      });

      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({
          name: 'conversation.input.left',
          id: 'quick-actions.trigger',
          order: 10,
          label: function triggerLabel() {
            return t('menu.title');
          },
        }, function QuickActionsTrigger() {
          const menuState = useSyncExternalStore(menuStore.subscribe, menuStore.getSnapshot, menuStore.getSnapshot);
          const isOpen = Boolean(menuState && menuState.open);
          return h('button', {
            type: 'button',
            className: 'qa-trigger' + (isOpen ? ' qa-trigger--open' : ''),
            title: t('menu.title'),
            'aria-label': t('menu.title'),
            'aria-haspopup': 'dialog',
            'aria-expanded': isOpen ? 'true' : 'false',
            onClick: function toggleMenu(event) {
              if (isOpen) {
                closeMenu();
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu({ left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right });
            },
          }, renderKeyIcon(18));
        });
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'quick-actions.menu',
          order: 61,
        }, function QuickActionsMenu() {
          const menuState = useSyncExternalStore(menuStore.subscribe, menuStore.getSnapshot, menuStore.getSnapshot);
          const catalogState = useSyncExternalStore(catalogStore.subscribe, catalogStore.getSnapshot, catalogStore.getSnapshot);
          const menuRef = useRef(null);
          const isOpen = Boolean(menuState && menuState.open);

          useEffect(function closeOnOutsidePress() {
            if (!isOpen) return undefined;
            function onMouseDown(event) {
              const target = event.target;
              const menuEl = menuRef.current;
              if (menuEl && target && menuEl.contains(target)) return;
              if (target && typeof target.closest === 'function') {
                try {
                  if (target.closest('.qa-trigger')) return;
                } catch (error) {
                  /* a non-Element target has no closest() */
                }
              }
              closeMenu();
            }
            document.addEventListener('mousedown', onMouseDown, true);
            return function removeOutsidePress() {
              document.removeEventListener('mousedown', onMouseDown, true);
            };
          }, [isOpen]);

          if (!isOpen) return null;

          const catalog = mergeCatalog(catalogState.catalog, catalogState.custom);
          const overrides = catalogState.overrides || {};
          const localeId = activeLocaleId();
          const anchor = menuState.anchor || { left: 16, top: (window.innerHeight || 768) - 96 };
          const viewportWidth = window.innerWidth || 1024;
          const width = Math.max(240, Math.min(328, viewportWidth - 24));
          const left = Math.max(12, Math.min(anchor.left, viewportWidth - width - 12));
          const bottom = Math.max(12, (window.innerHeight || 768) - anchor.top + 8);

          let body;
          if (!catalog || !Array.isArray(catalog.actions)) {
            body = h('div', { className: 'qa-menu__loading' },
              catalogState.error ? t('page.catalog.error') : t('page.catalog.loading'));
          } else {
            const groups = (catalog.groups || []).slice().sort(function byOrder(a, b) {
              return (a.order || 0) - (b.order || 0);
            });
            const actions = catalog.actions.slice().sort(function byOrder(a, b) {
              return (a.order || 0) - (b.order || 0);
            });
            body = groups.map(function renderGroup(group) {
              const rows = actions.filter(function inGroup(action) { return action.group === group.id; });
              if (rows.length === 0) return null;
              return h('div', { className: 'qa-menu__group', key: group.id },
                h('div', { className: 'qa-menu__group-title' }, pickText(group.title, localeId)),
                rows.map(function renderItem(action) {
                  const shortcut = effectiveShortcut(action, overrides);
                  return h('button', {
                    type: 'button',
                    key: action.id,
                    className: 'qa-menu__item',
                    title: pickText(action.hint, localeId),
                    onClick: function run() {
                      closeMenu();
                      runAction(action);
                    },
                  },
                    h('span', { className: 'qa-menu__item-title' }, pickText(action.title, localeId)),
                    h('span', { className: 'qa-menu__item-key' },
                      shortcut === '' ? t('page.unbound') : renderShortcutChips(shortcut, t('page.unbound'))),
                  );
                }),
              );
            });
          }

          const directory = currentWorkspacePath();
          return h('div', {
            className: 'qa-menu',
            style: { left: left + 'px', bottom: bottom + 'px', width: width + 'px' },
            ref: menuRef,
            role: 'dialog',
            'aria-label': t('menu.title'),
          },
            h('div', { className: 'qa-menu__head' },
              h('span', { className: 'qa-menu__head-title' }, t('menu.title')),
            ),
            body,
            h('div', { className: 'qa-menu__foot' },
              directory
                ? h('span', { className: 'qa-menu__foot-path', title: directory }, t('menu.runsIn') + ' ' + baseName(directory))
                : h('span', null, t('menu.hint')),
            ),
          );
        });
      });

      ctx.slots.inject('settings.section.icon', function () {
        return ctx.slots.register({
          name: 'settings.section.icon',
          id: 'quick-actions',
          order: 47,
        }, function QuickActionsNavIcon(iconProps) {
          return renderKeyIcon(iconProps && typeof iconProps.size === 'number' ? iconProps.size : 16);
        });
      });

      if (locale && typeof locale.register === 'function') {
        try {
          locale.register(NS, 'zh', DICTS.zh);
          locale.register(NS, 'en', DICTS.en);
        } catch (error) {
          /* an already-registered namespace keeps the existing dictionary */
        }
      }
    }

    const CSS = [
      '.qa-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary); font-size: 14px; }',
      '.qa-page__title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; color: var(--dsw-alias-label-primary); }',
      '.qa-page__desc { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }',
      '.qa-add { display: flex; align-items: center; justify-content: center; width: 100%; padding: 9px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }',
      '.qa-add:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.qa-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
      '.qa-input { box-sizing: border-box; width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }',
      '.qa-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 0; }',
      '.qa-textarea { resize: vertical; min-height: 62px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; }',
      '.qa-form__note { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-form__actions { display: flex; gap: 8px; }',
      '.qa-button { padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.qa-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.qa-button:disabled { opacity: 0.45; cursor: default; }',
      '.qa-button--primary { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-primary); color: #ffffff; }',
      '.qa-button--primary:hover:not(:disabled) { opacity: 0.92; }',
      '.qa-reset--danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }',
      '.qa-reset--armed { width: auto; padding: 0 6px; font-size: 11px; color: var(--dsw-alias-state-error-primary); }',
      '.qa-setting { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }',
      '.qa-setting__label { font-size: 13px; color: var(--dsw-alias-label-primary); }',
      '.qa-setting__select { max-width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }',
      '.qa-setting__select:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
      '.qa-setting__hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-probe { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; }',
      '.qa-probe__label { font-size: 13px; color: var(--dsw-alias-label-secondary); }',
      '.qa-probe__value { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--dsw-alias-label-primary); }',
      '.qa-probe__idle { font-size: 13px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-probe__raw { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-page__hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-trigger { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
      '.qa-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.qa-trigger:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
      '.qa-trigger--open { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.qa-menu { position: fixed; z-index: 60; pointer-events: auto; display: flex; flex-direction: column; gap: 4px; max-height: min(70vh, 560px); overflow: auto; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.22); }',
      '.qa-menu__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 2px 6px 6px; }',
      '.qa-menu__head-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }',
      '.qa-menu__group { display: flex; flex-direction: column; gap: 2px; padding-top: 2px; }',
      '.qa-menu__group-title { padding: 4px 8px 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-menu__item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }',
      '.qa-menu__item:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.qa-menu__item:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: -1px; }',
      '.qa-menu__item-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.qa-menu__item-key { flex: none; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-menu__loading { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.qa-menu__foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; padding: 6px 8px 2px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-menu__foot-path { max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.qa-group { display: flex; flex-direction: column; gap: 8px; }',
      '.qa-group__title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.qa-group__rows { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden; }',
      '.qa-row { display: flex; align-items: center; gap: 16px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); }',
      '.qa-row + .qa-row { border-top: 1px solid var(--dsw-alias-border-l1); }',
      '.qa-row:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.qa-row__text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }',
      '.qa-row__title { font-size: 14px; color: var(--dsw-alias-label-primary); }',
      '.qa-row__hint { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
      '.qa-row__cmd { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-markdown-inline-code); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.qa-row__controls { display: flex; align-items: center; gap: 8px; flex: none; }',
      '.qa-key { display: inline-flex; align-items: center; gap: 4px; min-width: 78px; min-height: 30px; justify-content: center; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.qa-key:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.qa-key:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
      '.qa-key--recording { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-primary); color: #ffffff; }',
      '.qa-key--recording:hover { background: var(--dsw-alias-state-business-primary); }',
      '.qa-key__recording { font-size: 12px; }',
      '.qa-key__unbound { color: var(--dsw-alias-label-tertiary); }',
      '.qa-key--unbound { border-style: dashed; }',
      '.qa-kbd { font-family: inherit; font-size: 12px; line-height: 16px; }',
      '.qa-reset { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; cursor: pointer; }',
      '.qa-reset:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.qa-reset:disabled { opacity: 0.35; cursor: default; }',
      '.qa-footer { display: flex; align-items: flex-start; gap: 14px; padding-top: 4px; }',
      '.qa-footer__button { flex: none; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }',
      '.qa-footer__button:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.qa-footer__hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }',
      '.qa-notice-layer { position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%); z-index: 40; display: flex; justify-content: center; pointer-events: none; width: min(560px, calc(100vw - 48px)); }',
      '.qa-notice { animation: qa-notice-in 140ms ease-out; pointer-events: auto; display: flex; flex-direction: column; gap: 6px; min-width: 220px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); }',
      '.qa-notice__head { display: flex; align-items: center; gap: 8px; }',
      '.qa-notice__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }',
      '.qa-notice--ok .qa-notice__dot { background: var(--dsw-alias-state-success-primary); }',
      '.qa-notice--error .qa-notice__dot { background: var(--dsw-alias-state-error-primary); }',
      '.qa-notice--pending .qa-notice__dot { background: var(--dsw-alias-state-business-primary); }',
      '.qa-notice__title { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }',
      '.qa-notice__close { flex: none; width: 20px; height: 20px; border: none; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1; cursor: pointer; }',
      '.qa-notice__close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
      '.qa-notice__detail { margin: 0; max-height: 148px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }',
      '.qa-notice__meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }',
      '@keyframes qa-notice-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
    ].join('\n');

    return {
      inject: ['slots'],
      apply,
    };
  },
});
