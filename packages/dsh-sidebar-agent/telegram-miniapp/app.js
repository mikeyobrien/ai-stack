(() => {
  const META = /\n<!--meta:([\s\S]*?)-->\s*$/
  const view = document.querySelector('#view')
  const state = document.querySelector('#state')
  const retryButton = document.querySelector('#retry')
  const initData = () => {
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('tgWebAppData')
    const fromQuery = new URLSearchParams(location.search).get('initData')
    return (window.Telegram?.WebApp?.initData) || fromHash || fromQuery || ''
  }
  const ready = () => window.Telegram?.WebApp?.ready()
  ready()
  const parseMeta = (text) => {
    const match = META.exec(String(text ?? ''))
    if (match === null) return null
    try {
      const meta = JSON.parse(match[1])
      if (meta === null || typeof meta !== 'object' || (meta.kind !== 'pulse' && meta.kind !== 'deployment')) return null
      return { plain: String(text).slice(0, match.index), meta }
    } catch { return null }
  }
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value)
    for (const child of children) node.append(child)
    return node
  }
  const card = ({ plain, meta }) => {
    const stateName = String(meta.state ?? meta.live ?? meta.holding ?? meta.reason ?? '').toUpperCase()
    const cls = stateName.includes('BLOCK') ? ' blocked' : stateName.includes('LIVE') || stateName.includes('DONE') ? ' live' : ''
    const box = el('article', { class: `card${cls}` })
    box.append(el('h2', {}, `${meta.kind === 'pulse' ? '🎤 ' : ''}${meta.title ?? meta.kind}`))
    if (typeof plain === 'string' && plain.trim() !== '') box.append(el('p', { class: 'card-text' }, plain.trim()))
    const rows = el('div', { class: 'row' })
    for (const [label, key] of [['State', 'state'], ['Session', 'session'], ['Changed', 'changed'], ['Verified', 'verified'], ['Live', 'live'], ['Holding', 'holding'], ['Gaps', 'gaps'], ['Reason', 'reason']]) {
      const value = meta[key]
      if (typeof value !== 'string' || value === '') continue
      rows.append(el('b', {}, label), el('span', {}, value.length > 180 ? `${value.slice(0, 179)}…` : value))
    }
    box.append(rows)
    return box
  }
  const render = (items, empty) => {
    view.replaceChildren()
    if (!items.length) { view.append(el('p', { class: 'empty' }, empty)); return }
    for (const item of items) {
      const parsed = typeof item === 'string' ? parseMeta(item) : item
      if (parsed?.meta) view.append(card(parsed))
      else view.append(el('p', { class: 'empty' }, typeof item === 'string' ? item : JSON.stringify(item)))
    }
  }
  const renderPending = (pending) => {
    view.replaceChildren()
    if (!pending) { view.append(el('p', { class: 'empty' }, 'No delegation questions.')); return }
    const box = el('article', { class: 'card' })
    box.append(el('h2', {}, String(pending.question ?? 'Question')))
    const options = Array.isArray(pending.options) ? pending.options : []
    for (const option of options) box.append(el('p', { class: 'empty' }, option))
    view.append(box)
  }
  const renderError = (message) => {
    view.replaceChildren(el('p', { class: 'empty' }, message))
    retryButton.hidden = false
    state.textContent = 'error'
  }
  const retry = async () => {
    retryButton.hidden = true
    await activate(document.querySelector('nav button[aria-current="page"]'))
  }
  const api = async (name) => {
    const response = await fetch(`api/${name}`, { headers: { accept: 'application/json', 'x-telegram-init-data': initData() } })
    if (!response.ok) {
      if (response.status === 401) { renderError('Authentication required. Re-open the app in Telegram to re-authenticate.'); return { unauthorized: true } }
      if (response.status === 403) { renderError('Access denied. You are not authorised for this bot.'); return { unauthorized: true } }
      throw new Error(`HTTP ${response.status}`)
    }
    return response.json()
  }
  const table = (title, rows) => {
    const box = el('article', { class: 'card' })
    box.append(el('h2', {}, title))
    const grid = el('div', { class: 'row' })
    for (const [label, value] of rows) {
      if (value === '' || value === null || value === undefined) continue
      grid.append(el('b', {}, label), el('span', {}, String(value).length > 180 ? `${String(value).slice(0, 179)}…` : String(value)))
    }
    box.append(grid)
    return box
  }
  const views = {
    status: async () => {
      const data = await api('status')
      if (data.unauthorized) return
      const model = data.model ? `${data.model.provider} / ${data.model.model}` : ''
      view.replaceChildren(table('mAgent', [['State', data.running ? 'LIVE' : 'IDLE'], ['Session', data.session], ['Changed', model]]))
    },
    pulses: async () => {
      const data = await api('pulses')
      if (data.unauthorized) return
      render(data.pulses, 'No pulse history.')
    },
    questions: async () => {
      const data = await api('questions')
      if (data.unauthorized) return
      renderPending(data.pending)
    },
    log: async () => {
      const data = await api('decision-log')
      if (data.unauthorized) return
      const items = (data.records ?? []).map((record) => {
        if (typeof record === 'string') return record
        if (record === null || typeof record !== 'object') return record
        return { meta: record }
      })
      render(items, 'No decision-log records.')
    },
  }
  const activate = async (button) => {
    if (button === null || typeof button.dataset.view !== 'string') return
    state.textContent = 'loading…'
    for (const other of document.querySelectorAll('nav button')) other.setAttribute('aria-current', other === button ? 'page' : 'false')
    try { await views[button.dataset.view](); state.textContent = 'read-only' }
    catch (error) { renderError(String(error.message ?? error)) }
  }
  for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', () => activate(button))
  retryButton.addEventListener('click', retry)
  activate(document.querySelector('nav button[aria-current="page"]'))
})()
