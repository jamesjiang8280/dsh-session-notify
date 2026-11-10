/**
 * Browser half of `dsh-session-notify`.
 *
 * Renders macOS-style toast notifications at the top-right corner of the DSH
 * window pane. Notifications are raised when:
 *
 *  - a session's turn completes (`turn/end`);
 *  - a session needs user interaction (ask-user / tool approval).
 *
 * The component polls the host's notification drain endpoint and projects each
 * pending notification into a `shell.overlay` slot rendered at the top-right
 * of the page. All React state lives inside the registered React component —
 * the plugin `apply()` is a plain wiring function and must never call hooks.
 *
 * @module dsh-session-notify/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-notify',
  factory: (require) => {
    /** Loaded-bundle marker, readable from the console to verify the build. */
    const CLIENT_VERSION = '2026-11-10.3'
    try {
      if (typeof window !== 'undefined') window.__DSH_SESSION_NOTIFY_VERSION__ = CLIENT_VERSION
    } catch {
      // ignore
    }

    /**
     * Report a client-side fact to the Host so `/debug` can show what the
     * browser really sees (bundle version, service availability, click outcome).
     */
    function reportStatus(fields) {
      try {
        const qs = new URLSearchParams({ v: CLIENT_VERSION, ...fields }).toString()
        fetch(`dsh-session-notify/client-status?${qs}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        }).catch(() => {})
      } catch {
        // reporting is best-effort
      }
    }

    const React = require('react')
    const { useEffect, useState, useCallback, useRef } = React
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-session-notify'

    /** Dictionaries. */
    const zh = {
      'turn-end': '会话回合已完成',
      'interaction': '会话需要交互',
      'dismiss': '关闭',
      'title': '会话提醒',
    }
    const en = {
      'turn-end': 'Turn completed',
      'interaction': 'Interaction required',
      'dismiss': 'Dismiss',
      'title': 'Session notification',
    }

    /** Stylesheet id. */
    const STYLE_ID = 'dsh-session-notify-styles'
    /** Notification container id. */
    const CONTAINER_ID = 'dsh-session-notify-container'

    /**
     * Relative path of the Host drain route, resolved against
     * `document.baseURI` (no leading slash, same convention as the reference
     * plugins) so it survives an app mounted under a prefix.
     */
    const ROUTE_PATH = 'dsh-session-notify/notifications'

    /** Poll interval for the host drain endpoint. */
    const POLL_MS = 2000

    /** Maximum number of toasts retained on screen. */
    const MAX_VISIBLE = 50

    /**
     * Install the macOS-style notification stylesheet once.
     * @returns cleanup function that removes the stylesheet.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      let el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = `
#${CONTAINER_ID} {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
  width: 360px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
#${CONTAINER_ID} > * {
  pointer-events: auto;
}
.dsn-toast {
  background: rgba(20, 20, 22, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  color: #ffffff;
  padding: 12px 14px;
  pointer-events: auto;
  /* Visible by default: never depend on a keyframe to become readable, so a
     blocked animation or prefers-reduced-motion cannot hide toasts. */
  opacity: 1;
  animation: dsnSlideIn 0.32s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 64px;
  max-width: 100%;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.dsn-toast:hover {
  transform: translateX(0) scale(1.02);
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.4);
}
.dsn-toast.kind-turn-end {
  border-left: 4px solid #34c759;
}
.dsn-toast.kind-interaction {
  border-left: 4px solid #ff9500;
}
.dsn-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
}
.dsn-icon.kind-turn-end { background: rgba(52, 199, 89, 0.18); color: #34c759; }
.dsn-icon.kind-interaction { background: rgba(255, 149, 0, 0.18); color: #ff9500; }
.dsn-body { flex: 1; min-width: 0; }
.dsn-title {
  font-weight: 600;
  font-size: 13px;
  line-height: 1.25;
  margin: 0 0 4px 0;
  color: #ffffff;
}
.dsn-message {
  font-size: 12.5px;
  line-height: 1.4;
  margin: 0;
  color: #e5e5ea;
  overflow-wrap: break-word;
}
.dsn-dismiss {
  flex-shrink: 0;
  margin-left: 8px;
  padding: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #ffffff;
  cursor: pointer;
  line-height: 1;
}
.dsn-dismiss:hover { background: rgba(255, 255, 255, 0.18); }
.dsn-dismiss:active { background: rgba(255, 255, 255, 0.28); }
@keyframes dsnSlideIn {
  to { transform: translateX(0); opacity: 1; }
}
.dsn-toast.exiting {
  animation: dsnSlideOut 0.24s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes dsnSlideOut {
  to { transform: translateX(120%); opacity: 0; }
}
@media (prefers-color-scheme: light) {
  .dsn-toast { background: rgba(245, 245, 247, 0.94); color: #1c1c1e; }
  .dsn-toast .dsn-title { color: #1c1c1e; }
  .dsn-toast .dsn-message { color: #4b4b50; }
  .dsn-dismiss { background: rgba(0, 0, 0, 0.08); color: #1c1c1e; }
  .dsn-dismiss:hover { background: rgba(0, 0, 0, 0.16); }
}
`
        document.head.appendChild(el)
      }
      return () => {
        el.remove()
      }
    }

    /**
     * Navigate to a session in the current tab.
     *
     * Uses the framework's own in-place session switch — the same call the
     * sidebar makes when a session row is clicked. DSH has no `/sessions/:id`
     * route (the server answers 404), so this plugin never changes the
     * location; when the service is unreachable it logs and stays put.
     */
    function navigateToSession(ctxRef, sessionId) {
      const candidates = ['uiWorkspace', 'workspaceNavigation']
      for (const name of candidates) {
        try {
          const svc = typeof ctxRef.get === 'function' ? ctxRef.get(name) : undefined
          if (svc && typeof svc.openSession === 'function') {
            svc.openSession(sessionId)
            reportStatus({ click: 'ok', sessionId, service: name })
            return true
          }
        } catch (err) {
          // remember the error and try the next candidate
          try {
            console.warn('[dsh-session-notify] openSession failed via', name, err)
          } catch {
            // ignore
          }
        }
      }
      try {
        console.warn('[dsh-session-notify] uiWorkspace.openSession unavailable; cannot switch to session', sessionId,
          'loaded client version:', CLIENT_VERSION)
      } catch {
        // ignore
      }
      reportStatus({ click: 'fail', sessionId, clickErr: 'openSession unavailable' })
      return false
    }

    /**
     * One toast item.
     */
    function ToastItem({ notification, onDismiss, t, ctxRef }) {
      const kind = notification.kind === 'interaction' ? 'interaction' : 'turn-end'
      const title = kind === 'interaction' ? t('interaction') : t('turn-end')
      
      /**
       * Handle toast click: navigate to the session in the current tab.
       */
      const handleToastClick = () => {
        if (notification.sessionId) {
          navigateToSession(ctxRef, notification.sessionId)
        }
      }

      return h('div', {
        className: `dsn-toast kind-${kind}`,
        role: 'alert',
        'aria-label': `${title}. ${notification.message}`,
        onClick: handleToastClick,
        style: { cursor: 'pointer' },
      },
        h('div', { className: `dsn-icon kind-${kind}`, 'aria-hidden': 'true' },
          kind === 'interaction' ? '!' : '✓'
        ),
        h('div', { className: 'dsn-body' },
          h('p', { className: 'dsn-title' }, title),
          h('p', { className: 'dsn-message' }, notification.message)
        ),
        h('button', {
          type: 'button',
          className: 'dsn-dismiss',
          'aria-label': t('dismiss'),
          onClick: (e) => {
            e.stopPropagation() // Prevent toast click when dismissing
            onDismiss(notification.id)
          },
        }, '×')
      )
    }

    /**
     * Notification container rendered into shell.overlay.
     *
     * `props.ctx` carries the plugin context through the slot's `inject()`,
     * so toast clicks can reach the framework's `uiWorkspace` navigation
     * service. This is a real React component: all hooks (state, polling
     * timer, callbacks) live here — never in the plugin `apply()` wiring.
     */
    function NotificationPanel(props) {
      const ctxRef = props && (props.ctxRef || props.ctx)
      const [notifications, setNotifications] = useState([])
      const mountedRef = useRef(true)

      /**
       * Fetch pending notifications from the host drain endpoint.
       */
      const fetchNotifications = useCallback(async () => {
        try {
          const res = await fetch(ROUTE_PATH, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          })
          if (!res.ok) return
          const payload = await res.json()
          const batch = Array.isArray(payload.notifications) ? payload.notifications : []
          if (batch.length > 0) {
            setNotifications((prev) => {
              const seen = new Set(prev.map((n) => n.id))
              const merged = [...prev]
              for (const n of batch) {
                if (!seen.has(n.id)) merged.push(n)
              }
              return merged.slice(-MAX_VISIBLE)
            })
          }
        } catch {
          // Endpoint may not exist on compositions without the host half; fail quiet.
        }
      }, [])

      // Poll the drain endpoint while mounted.
      useEffect(() => {
        mountedRef.current = true
        fetchNotifications()
        const timer = setInterval(() => {
          if (mountedRef.current) fetchNotifications()
        }, POLL_MS)
        return () => {
          mountedRef.current = false
          clearInterval(timer)
        }
      }, [fetchNotifications])

      /**
       * Dismiss one notification by id (client-side only).
       */
      const dismiss = useCallback((id) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id))
      }, [])

      /** Resolve display text following the browser language. */
      const t = (key) => {
        try {
          const lang = (typeof navigator !== 'undefined' && navigator.language || '').toLowerCase()
          const dict = lang.startsWith('zh') ? zh : en
          return dict[key] || en[key] || key
        } catch {
          return en[key] || key
        }
      }

      return h('div', { id: CONTAINER_ID },
        notifications.map((n) =>
          h(ToastItem, { key: n.id, notification: n, onDismiss: dismiss, t, ctxRef })
        )
      )
    }

    /**
     * Client plugin body: wiring only — dictionaries, stylesheet, and the
     * single shell.overlay occupant. No hooks may be called here.
     */
    function apply(ctx) {
      // Register dictionaries when the locale service exposes register().
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-session-notify: dictionaries')
        }
      } catch {
        // The component falls back to its built-in dictionaries.
      }

      // Stylesheet lifetime is bound to the plugin.
      ctx.effect(() => installStyles(), 'dsh-session-notify: styles')

      /** Late-bound client root context, handed to toasts for session navigation. */
      const ctxRef = { get: (name) => {
        try { return ctx.get(name) } catch { return undefined }
      } }

      // Register into shell.overlay so toasts paint at the top-right corner.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-session-notify.panel',
            order: 200,
            locale: NS,
            inject: () => ({ ctxRef }),
          },
          NotificationPanel,
        ),
      )

      // Tell the Host what this bundle can see, so `/debug` can prove which
      // client build is live and whether the session-switch service resolves.
      try {
        let svc
        let err = ''
        try {
          svc = ctxRef.get('uiWorkspace')
        } catch (e) {
          err = String(e && e.message || e).slice(0, 120)
        }
        reportStatus({
          uiWorkspace: svc ? 'yes' : 'no',
          openSession: svc && typeof svc.openSession === 'function' ? 'yes' : 'no',
          err,
        })
      } catch {
        // ignore
      }
    }

    return {
      // `uiWorkspace` is read lazily via ctx.get() at click time (cordis allows
      // reading a service without declaring it in inject), so a composition
      // without it can still mount the toasts.
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
