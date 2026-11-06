(() => {
  const META = /\n<!--meta:([\s\S]*?)-->\s*$/
  const view = document.querySelector('#view')
  const state = document.querySelector('#state')
  const initData = () => {
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('tgWebAppData')
    const fromQuery = new URLSearchParams(location.search).get('initData')
    return (window.Telegram?.WebApp?.initData) || fromHash || fromQuery || ''
  }
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
  const card = ({ meta }) => {
    const stateName = String(meta.state ?? meta.live ?? meta.holding ?? meta.reason ?? '').toUpperCase()
    const cls = stateName.includes('BLOCK') ? ' blocked' : stateName.includes('LIVE') || stateName.includes('DONE') ? ' live' : ''
    const box = el('article', { class: `card${cls}` })
    box.append(el('h2', {}, `${meta.kind === 'pulse' ? '🎤 ' : ''}${meta.title ?? meta.kind}`))
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
  const api = async (name) => {
    const response = await fetch(`api/${name}`, { headers: { accept: 'application/json', 'x-telegram-init-data': initData() } })
    if (!response.ok) throw new Error(response.status === 401 ? 'Telegram auth required' : `HTTP ${response.status}`)
    return response.json()
  }
  const views = {
    pulses: async () => { const data = await api('pulses'); render(data.pulses, 'No pulse history.') },
    questions: async () => { const data = await api('questions'); render(data.questions, data.pending ? 'A question is pending.' : 'No delegation questions.') },
    status: async () => { const data = await api('status'); render([{ title: 'mAgent', state: data.running ? 'LIVE' : 'IDLE', session: data.session, changed: data.model ? `${data.model.provider}/${data.model.model}` : '' }], 'No status.') },
    log: async () => { const data = await api('decision-log'); render(data.records, 'No decision-log records.') },
  }
  for (const button of document.querySelectorAll('nav button')) {
    button.addEventListener('click', async () => {
      state.textContent = 'loading…'
      try { await views[button.dataset.view](); state.textContent = 'read-only' }
      catch (error) { view.replaceChildren(el('p', { class: 'empty' }, String(error.message ?? error))); state.textContent = 'error' }
    })
  }
  views.status().catch(() => {})
})()
