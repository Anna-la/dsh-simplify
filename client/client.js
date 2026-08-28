// dsh-simplify — browser bundle (client half).
//
// Hand-written in the DSH client module-table format:
//   window.__ModuleLoader__.load({ id, factory })
// The factory is a lazy CJS module body; `require` resolves only the host seed
// modules (react, …) and already-registered graph rows. This bundle is fully
// self-contained: no external npm imports beyond `react`.
//
// Behaviour:
//   · registers a toggle button into `sidebar.footer.action` (rendered directly
//     above the settings gear) — click to enter/exit "clean mode";
//   · in clean mode a highlight box follows the hovered element, right-click
//     removes it (left-click untouched), Esc exits;
//   · every removal moves the element into a hidden "limbo" container (kept as
//     the live node, id stripped) and records XPath + outerHTML + parent/index
//     into localStorage; a MutationObserver sweep keeps removals alive across
//     re-renders and reloads by re-removing only elements whose outerHTML
//     exactly matches the recorded snapshot — position-drifted neighbours are
//     never touched (no cascade deletes);
//   · registers a `settings.section` entry (id `simplify`) rendering the list
//     of removed elements with per-item 恢复, per-item checkbox and 批量恢复 —
//     each row also draws the element again at its original style: the live
//     node is parked into the row's preview area, so clicking it performs the
//     element's original action without restoring it to its old position.

window.__ModuleLoader__.load({
	id: 'dsh-simplify',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		var react = require('react')
		var h = react.createElement
		var useState = react.useState
		var useEffect = react.useEffect
		var useRef = react.useRef

		const NS = 'simplify'
		const STORE_KEY = 'dsh-simplify:records:v1'
		const MAX_RECORDS = 300
		const OWN_ATTR = 'data-dsh-simplify-own'
		const HIGHLIGHT_Z = 2147483000
		const HINT_Z = 2147483001

		/* ── state ─────────────────────────────────────────────────────────── */

		const state = {
			active: false,          // clean mode on/off
			records: [],            // persisted removal records, newest first
			checked: new Set(),     // checkboxes in the settings section
		}
		const listeners = new Set()
		let persistTimer = 0
		let sweepTimer = 0
		let observer = null
		let hintEl = null
		let hintMsgEl = null
		let highlightEl = null
		let limboEl = null
		let movePending = 0
		let lastX = 0
		let lastY = 0
		let destroyed = false

		function notify() {
			for (const fn of [...listeners]) {
				try { fn() } catch (_) { /* a listener must never break the engine */ }
			}
		}
		function subscribe(fn) {
			listeners.add(fn)
			return () => listeners.delete(fn)
		}

		/* ── storage ───────────────────────────────────────────────────────── */

		function schedulePersist() {
			if (persistTimer) clearTimeout(persistTimer)
			persistTimer = setTimeout(() => {
				persistTimer = 0
				try {
					// `_live` is a runtime node reference — never persist it.
					localStorage.setItem(STORE_KEY, JSON.stringify(state.records.map((r) => {
						const copy = Object.assign({}, r)
						delete copy._live
						return copy
					})))
				} catch (_) { /* quota / privacy mode — keep in-memory only */ }
			}, 120)
		}
		function loadRecords() {
			try {
				const raw = localStorage.getItem(STORE_KEY)
				if (!raw) return
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return
				state.records = parsed
					.filter((r) => r && typeof r === 'object'
						&& typeof r.id === 'string'
						&& typeof r.xpath === 'string'
						&& typeof r.html === 'string'
						&& typeof r.parentXpath === 'string'
						&& typeof r.index === 'number'
						&& typeof r.label === 'string')
					.slice(0, MAX_RECORDS)
			} catch (_) { state.records = [] }
		}

		/* ── DOM helpers ───────────────────────────────────────────────────── */

		function isOwnUi(el) {
			return !!(el && (el === highlightEl || el === hintEl
				|| (typeof el.closest === 'function' && el.closest('[' + OWN_ATTR + ']'))))
		}
		function isProtectedRoot(el) {
			if (!el) return true
			const tag = el.tagName
			return tag === 'HTML' || tag === 'BODY' || tag === 'HEAD'
		}
		function inShadowDom(el) {
			return !!(el.getRootNode && el.getRootNode() !== document)
		}
		function findEl(xpath) {
			if (!xpath || typeof document.evaluate !== 'function') return null
			try {
				const res = document.evaluate(xpath, document, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null)
				const node = res && res.singleNodeValue
				return node && node.nodeType === 1 ? node : null
			} catch (_) { return null }
		}
		function xpathOf(el) {
			if (!el || el.nodeType !== 1) return ''
			const parts = []
			let node = el
			while (node && node.nodeType === 1) {
				if (node === document.documentElement) { parts.unshift('/html'); break }
				const tag = node.tagName.toLowerCase()
				let idx = 1
				let sib = node.previousElementSibling
				while (sib) {
					if (sib.tagName.toLowerCase() === tag) idx += 1
					sib = sib.previousElementSibling
				}
				let more = false
				sib = node.nextElementSibling
				while (sib) {
					if (sib.tagName.toLowerCase() === tag) { more = true; break }
					sib = sib.nextElementSibling
				}
				parts.unshift(more || idx > 1 ? tag + '[' + idx + ']' : tag)
				node = node.parentElement
			}
			return parts.join('/')
		}
		function indexAmongChildren(el) {
			if (!el || !el.parentElement) return 0
			let idx = 0
			for (const child of el.parentElement.children) {
				if (child === el) return idx
				idx += 1
			}
			return Math.max(0, idx - 1)
		}
		// Hidden "limbo" container: removed elements live here (kept alive as the
		// same node, id stripped so document.getElementById never collides) and
		// are parked into the settings preview rows while that page is open.
		function ensureLimbo() {
			if (limboEl && limboEl.isConnected) return limboEl
			limboEl = document.createElement('div')
			limboEl.setAttribute(OWN_ATTR, 'true')
			limboEl.dataset.dshLimbo = 'true'
			limboEl.style.display = 'none'
			document.body.appendChild(limboEl)
			return limboEl
		}
		function moveToLimbo(el) {
			if (!el) return
			if (el.id) el.removeAttribute('id')
			ensureLimbo().appendChild(el)
		}
		function moveAllLiveToLimbo() {
			for (const rec of state.records) {
				if (rec._live && rec._live.isConnected) moveToLimbo(rec._live)
			}
		}
		function trimText(s, max) {
			const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
			return t.length > max ? t.slice(0, max - 1) + '…' : t
		}
		function labelOf(el) {
			const tag = (el.tagName || '').toLowerCase()
			const attr = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt')
			if (attr && attr.trim()) return tag + ' · ' + trimText(attr, 60)
			const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
			if (text) return tag + ' · ' + trimText(text, 60)
			return tag
		}

		/* ── highlight + hint ──────────────────────────────────────────────── */

		function ensureHighlight() {
			if (highlightEl && highlightEl.isConnected) return
			highlightEl = document.createElement('div')
			highlightEl.className = 'ds-s-highlight'
			highlightEl.setAttribute('aria-hidden', 'true')
			document.body.appendChild(highlightEl)
		}
		function ensureHint() {
			if (hintEl && hintEl.isConnected) return
			hintEl = document.createElement('div')
			hintEl.className = 'ds-s-hint'
			hintEl.setAttribute(OWN_ATTR, 'true')
			hintEl.setAttribute('role', 'status')
			hintMsgEl = document.createElement('span')
			const exitBtn = document.createElement('button')
			exitBtn.type = 'button'
			exitBtn.textContent = '退出'
			exitBtn.addEventListener('click', (e) => {
				e.stopPropagation()
				exitCleanMode()
			})
			hintEl.appendChild(hintMsgEl)
			hintEl.appendChild(exitBtn)
			document.body.appendChild(hintEl)
		}
		function setHint(text) {
			ensureHint()
			if (hintMsgEl) hintMsgEl.textContent = text
		}
		function removeHint() {
			if (hintEl && hintEl.isConnected) hintEl.remove()
			hintEl = null
			hintMsgEl = null
		}
		function hideHighlight() {
			if (highlightEl) highlightEl.style.display = 'none'
		}

		/* ── clean mode ────────────────────────────────────────────────────── */

		function enterCleanMode() {
			if (state.active) return
			state.active = true
			if (!document.body) return
			ensureHighlight()
			setHint('清理模式：悬浮元素后右键单击即可移除 · 按 Esc 退出')
			notify()
		}
		function exitCleanMode() {
			if (!state.active) return
			state.active = false
			hideHighlight()
			removeHint()
			notify()
		}
		function toggleCleanMode() {
			if (state.active) exitCleanMode()
			else enterCleanMode()
		}

		function onContextMenu(e) {
			if (!state.active) return
			e.preventDefault()
			e.stopPropagation()
			removeTargetAt(e.clientX, e.clientY)
		}
		function onPointerMove(e) {
			if (!state.active) return
			lastX = e.clientX
			lastY = e.clientY
			if (movePending) return
			movePending = requestAnimationFrame(() => {
				movePending = 0
				updateHighlight(lastX, lastY)
			})
		}
		function onScrollOrResize() {
			if (state.active) hideHighlight()
		}
		function onKeyDown(e) {
			if (!state.active) return
			if (e.key === 'Escape') {
				e.preventDefault()
				e.stopPropagation()
				exitCleanMode()
			}
		}

		function updateHighlight(x, y) {
			if (!state.active || !document.body) return
			const el = document.elementFromPoint(x, y)
			if (!el || isOwnUi(el) || isProtectedRoot(el) || inShadowDom(el) || !el.isConnected) {
				hideHighlight()
				return
			}
			const rect = el.getBoundingClientRect()
			if (!rect || rect.width < 1 || rect.height < 1) { hideHighlight(); return }
			ensureHighlight()
			highlightEl.style.display = 'block'
			highlightEl.style.left = (rect.left - 2) + 'px'
			highlightEl.style.top = (rect.top - 2) + 'px'
			highlightEl.style.width = (rect.width + 4) + 'px'
			highlightEl.style.height = (rect.height + 4) + 'px'
		}

		function removeTargetAt(x, y) {
			if (!document.body) return
			const el = document.elementFromPoint(x, y)
			if (!el || isOwnUi(el) || isProtectedRoot(el) || inShadowDom(el) || !el.isConnected) return
			removeElement(el)
		}
		function removeElement(el) {
			if (!el || !el.parentElement) return false
			if (isOwnUi(el) || isProtectedRoot(el) || inShadowDom(el) || !el.isConnected) return false
			const parent = el.parentElement
			const record = {
				id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
				removedAt: Date.now(),
				xpath: xpathOf(el),
				html: el.outerHTML,
				parentXpath: xpathOf(parent),
				index: indexAmongChildren(el),
				label: labelOf(el),
				idAttr: el.id || '',
				_live: el,
			}
			moveToLimbo(el)
			state.records.unshift(record)
			if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS
			pruneChecked()
			schedulePersist()
			notify()
			if (state.active) setHint('已移除「' + trimText(record.label, 36) + '」· 可在 设置 → 简化 中恢复')
			return true
		}

		/* ── re-apply sweep (keeps removals alive across re-renders) ───────── */

		function scheduleSweep() {
			if (sweepTimer) clearTimeout(sweepTimer)
			sweepTimer = setTimeout(() => {
				sweepTimer = 0
				sweep()
			}, 60)
		}
		function sweep() {
			if (!document.body || destroyed) return
			for (const rec of state.records) {
				const el = findEl(rec.xpath)
				if (!el || !el.isConnected) continue
				// Our own live node (parked in limbo/preview) is never at the
				// recorded spot — but never touch it even if it somehow matches.
				if (rec._live && el.isSameNode(rec._live)) continue
				// Identity fingerprint: only re-remove an element whose markup is
				// byte-identical to the one the user originally removed. After a
				// re-render/list shift, the recorded position may now hold a
				// DIFFERENT element (e.g. the next nav row) — removing it would
				// cascade deletes down the column, so drifted neighbours are left
				// alone. React-recreated identical copies still match and die.
				if (el.outerHTML !== rec.html) continue
				if (isOwnUi(el) || isProtectedRoot(el) || inShadowDom(el)) continue
				el.remove()
			}
		}
		function ensureObserver() {
			if (observer) return
			observer = new MutationObserver(() => scheduleSweep())
			observer.observe(document.documentElement || document.body, { childList: true, subtree: true })
		}

		/* ── restore ───────────────────────────────────────────────────────── */

		function restoreById(id) {
			const ix = state.records.findIndex((r) => r.id === id)
			if (ix < 0) return 'missing'
			const rec = state.records[ix]
			const parent = findEl(rec.parentXpath)
			if (!parent || !parent.isConnected) return 'noparent'
			// Live node (still parked in limbo or a settings-preview row): move
			// the very same node back to its original position — id restored, so
			// the element is exactly as it was before removal.
			if (rec._live && rec._live.isConnected) {
				const twin = findEl(rec.xpath)
				if (twin && twin !== rec._live && twin.outerHTML === rec.html) twin.remove()
				if (rec.idAttr) rec._live.id = rec.idAttr
				const targetIndex = Math.min(rec.index, parent.children.length)
				parent.insertBefore(rec._live, parent.children[targetIndex] || null)
				rec._live = null
				state.records.splice(ix, 1)
				pruneChecked()
				schedulePersist()
				notify()
				return 'ok'
			}
			// Reload path: a re-created element must be byte-identical before we
			// treat it as "already back" — a drifted different element is not it.
			const existing = findEl(rec.xpath)
			if (existing && existing.isConnected && existing.outerHTML === rec.html) {
				state.records.splice(ix, 1)
				pruneChecked()
				schedulePersist()
				notify()
				return 'ok'
			}
			const tpl = document.createElement('template')
			tpl.innerHTML = rec.html
			const node = tpl.content.firstElementChild
			if (!node) return 'nomarkup'
			const targetIndex = Math.min(rec.index, parent.children.length)
			const ref = parent.children[targetIndex] || null
			parent.insertBefore(node, ref)
			state.records.splice(ix, 1)
			pruneChecked()
			schedulePersist()
			notify()
			return 'ok'
		}
		function restoreChecked() {
			const ids = [...state.checked]
			let restored = 0
			let skipped = 0
			for (const id of ids) {
				const result = restoreById(id)
				if (result === 'ok') restored += 1
				else skipped += 1
			}
			state.checked.clear()
			notify()
			return { restored, skipped }
		}
		function pruneChecked() {
			const alive = new Set(state.records.map((r) => r.id))
			for (const id of [...state.checked]) if (!alive.has(id)) state.checked.delete(id)
		}

		/* ── settings section component (设置 → 简化) ─────────────────────── */

		function renderSection(root) {
			if (!root || destroyed) return
			const records = state.records

			root.textContent = ''

			const head = document.createElement('div')
			head.className = 'ds-s-sec-head'

			const title = document.createElement('div')
			title.className = 'ds-s-sec-title'
			title.textContent = '简化'
			const sub = document.createElement('div')
			sub.className = 'ds-s-sec-sub'
			sub.textContent = records.length === 0
				? '这里管理被移除的页面元素。'
				: '已移除 ' + records.length + ' 个元素。预览区可点击体验原操作，恢复后原样回到原位置。'

			const tools = document.createElement('div')
			tools.className = 'ds-s-sec-tools'

			const checkAll = document.createElement('label')
			checkAll.className = 'ds-s-toggle-all'
			const checkAllBox = document.createElement('input')
			checkAllBox.type = 'checkbox'
			checkAllBox.className = 'ds-s-check'
			checkAllBox.dataset.dsAct = 'checkall'
			checkAll.appendChild(checkAllBox)
			checkAll.appendChild(document.createTextNode(' 全选'))

			const enterBtn = document.createElement('button')
			enterBtn.type = 'button'
			enterBtn.className = 'ds-s-btn'
			enterBtn.textContent = '进入清理模式'
			enterBtn.dataset.dsAct = 'enter-clean'

			const batchBtn = document.createElement('button')
			batchBtn.type = 'button'
			batchBtn.className = 'ds-s-btn ds-s-primary'
			batchBtn.textContent = '批量恢复'
			batchBtn.dataset.dsAct = 'restore-checked'
			batchBtn.disabled = state.checked.size === 0

			tools.appendChild(checkAll)
			tools.appendChild(enterBtn)
			tools.appendChild(batchBtn)

			head.appendChild(title)
			head.appendChild(sub)
			head.appendChild(tools)

			const list = document.createElement('ul')
			list.className = 'ds-s-list'

			for (const rec of records) {
				const li = document.createElement('li')
				li.className = 'ds-s-row'
				li.dataset.dsId = rec.id

				const box = document.createElement('input')
				box.type = 'checkbox'
				box.className = 'ds-s-check'
				box.dataset.dsAct = 'check'
				box.checked = state.checked.has(rec.id)

				const info = document.createElement('div')
				info.className = 'ds-s-row-info'
				const name = document.createElement('div')
				name.className = 'ds-s-row-name'
				name.textContent = rec.label
				name.title = rec.label
				const meta = document.createElement('div')
				meta.className = 'ds-s-row-meta'
				const when = rec.removedAt ? new Date(rec.removedAt).toLocaleString() : '—'
				meta.textContent = when + ' · ' + rec.xpath
				meta.title = '移除于 ' + when + '\n' + rec.xpath
				info.appendChild(name)
				info.appendChild(meta)

				const err = document.createElement('div')
				err.className = 'ds-s-row-err'
				err.textContent = '无法恢复：原位置对应的容器已不在页面中。'
				err.dataset.role = 'err'

				const restoreBtn = document.createElement('button')
				restoreBtn.type = 'button'
				restoreBtn.className = 'ds-s-btn ds-s-restore'
				restoreBtn.textContent = '恢复'
				restoreBtn.dataset.dsAct = 'restore'

				const preview = document.createElement('div')
				preview.className = 'ds-s-preview'
				preview.dataset.role = 'preview'
				preview.setAttribute(OWN_ATTR, 'true')
				const live = rec._live && rec._live.isConnected ? rec._live : null
				if (live) {
					// Park the very same node here: original style and events intact,
					// so clicking the preview performs the element's original action
					// without restoring it to its old position.
					preview.appendChild(live)
				} else {
					// Reloaded record: the recorded markup is the only thing left —
					// render it as a static, non-interactive style preview.
					const tpl = document.createElement('template')
					tpl.innerHTML = rec.html
					if (tpl.content.firstElementChild) preview.appendChild(tpl.content)
					const cap = document.createElement('div')
					cap.className = 'ds-s-preview-cap'
					cap.textContent = '刷新后快照 · 仅样式预览（无交互）'
					preview.appendChild(cap)
				}

				li.appendChild(box)
				li.appendChild(info)
				li.appendChild(restoreBtn)
				li.appendChild(err)
				li.appendChild(preview)
				list.appendChild(li)
			}

			const empty = document.createElement('div')
			empty.className = 'ds-s-empty'
			empty.style.display = records.length === 0 ? 'block' : 'none'
			empty.textContent = '还没有移除任何元素。点击左侧底部的「简化」按钮进入清理模式，鼠标悬浮到元素上按右键即可移除。'
			const hintLine = document.createElement('div')
			hintLine.className = 'ds-s-hintline'
			hintLine.textContent = '被移除的元素会持续隐藏（包括刷新之后）。行内预览区可点击执行该元素原本的操作，且不会还原位置；点击「恢复」才会把它原样放回原处。'

			root.appendChild(head)
			root.appendChild(list)
			root.appendChild(empty)
			root.appendChild(hintLine)

			// event delegation
			root.onchange = (e) => {
				const target = e.target
				if (!target || !target.dataset) return
				if (target.dataset.dsAct === 'check') {
					const id = target.closest('[data-ds-id]')?.dataset.dsId
					if (!id) return
					if (target.checked) state.checked.add(id)
					else state.checked.delete(id)
					const batch = root.querySelector('[data-ds-act="restore-checked"]')
					if (batch) batch.disabled = state.checked.size === 0
				} else if (target.dataset.dsAct === 'checkall') {
					if (target.checked) {
						for (const r of state.records) state.checked.add(r.id)
					} else {
						state.checked.clear()
					}
					renderSection(root)
				}
			}
			root.onclick = (e) => {
				const target = e.target && e.target.closest ? e.target.closest('[data-ds-act]') : null
				if (!target) return
				const act = target.dataset.dsAct
				if (act === 'restore') {
					const li = target.closest('[data-ds-id]')
					const id = li && li.dataset.dsId
					if (!id) return
					const result = restoreById(id)
					if (result !== 'ok' && li) {
						const err = li.querySelector('[data-role="err"]')
						if (err) {
							err.style.display = 'block'
							setTimeout(() => { err.style.display = 'none' }, 4000)
						}
					}
				} else if (act === 'restore-checked') {
					const res = restoreChecked()
					if (res.skipped > 0 && !res.restored) {
						const firstErr = root.querySelector('.ds-s-row-err')
						if (firstErr) {
							firstErr.style.display = 'block'
							setTimeout(() => { firstErr.style.display = 'none' }, 4000)
						}
					}
				} else if (act === 'enter-clean') {
					enterCleanMode()
				}
			}
		}

		function SimplifySection() {
			const rootRef = useRef(null)
			useEffect(() => {
				const root = rootRef.current
				if (!root) return
				const render = () => renderSection(root)
				render()
				const off = subscribe(render)
				return () => { off(); moveAllLiveToLimbo() }
			}, [])
			return h('div', { ref: rootRef, className: 'ds-s-sec', [OWN_ATTR]: 'true' })
		}

		/* ── sidebar toggle component ──────────────────────────────────────── */

		function SimplifyGlyph() {
			return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
				h('path', { d: 'M3.4 9.9 6.5 6.8l4.7 4.7-1.9 1.9H5.4L3.4 11.7z', fill: 'currentColor' }),
				h('path', { d: 'M7.2 6.1 10.4 2.9a.9.9 0 0 1 1.27 0l1.42 1.43a.9.9 0 0 1 0 1.27L9.9 8.5', stroke: 'currentColor', 'stroke-width': '1.3', fill: 'none' }),
				h('path', { d: 'M10.2 3.1l2.66 2.67', stroke: 'currentColor', 'stroke-width': '1.3', strokeLinecap: 'round' }),
				h('path', { d: 'M3.4 11.7 4.7 13.05H11.4', stroke: 'currentColor', 'stroke-width': '1.3', strokeLinecap: 'round' }))
		}

		function SimplifyToggle() {
			const [active, setActive] = useState(state.active)
			useEffect(() => subscribe(() => setActive(state.active)), [])
			return h('button', {
				type: 'button',
				[OWN_ATTR]: 'true',
				className: 'ds-s-toggle' + (active ? ' is-active' : ''),
				'aria-label': active ? '退出简化模式' : '进入简化模式（清理页面元素）',
				title: active ? '点击退出清理模式' : '点击进入清理模式：右键移除页面元素',
				onClick: (e) => { e.preventDefault(); e.stopPropagation(); toggleCleanMode() },
			}, [h(SimplifyGlyph, { key: 'g' })])
		}

		/* ── css ───────────────────────────────────────────────────────────── */

		const CSS_TEXT = `
.ds-s-highlight{position:fixed;pointer-events:none;z-index:${HIGHLIGHT_Z};box-sizing:border-box;border:2px solid #e5484d;border-radius:6px;background:rgba(229,72,77,.10);box-shadow:0 0 0 1px rgba(255,255,255,.45) inset;display:none}
.ds-s-hint{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:${HINT_Z};box-sizing:border-box;max-width:calc(100vw - 32px);display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:999px;background:rgba(18,22,28,.93);color:#fff;font-size:13px;line-height:20px;font-family:inherit;box-shadow:0 6px 24px rgba(0,0,0,.30);pointer-events:auto;user-select:none}
.ds-s-hint button{flex:none;cursor:pointer;border:none;border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;background:rgba(255,255,255,.16);color:#fff}
.ds-s-hint button:hover{background:rgba(255,255,255,.30)}
.ds-s-toggle{box-sizing:border-box;cursor:pointer;width:36px;height:36px;flex:none;color:var(--dsw-alias-label-primary,#262a33);background:transparent;border:none;border-radius:12px;align-items:center;justify-content:center;font-family:inherit;display:inline-flex}
.ds-s-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ds-s-toggle:active{transform:translateY(1px)}
.ds-s-toggle.is-active{background:rgba(229,72,77,.16);color:#cf353b}
.ds-s-toggle.is-active:hover{background:rgba(229,72,77,.26)}
/* 侧边栏折叠(rail)时：与 Cordis 面板等页脚按钮统一成 36px 圆形图标列 */
.hHd-Xa_collapsed .ds-s-toggle{width:36px;height:36px;border-radius:50%;margin:0;padding:0}
/* 折叠时页脚操作区排成一列（本插件在场时才生效） */
.hHd-Xa_collapsed .hHd-Xa_footerActions:has(.ds-s-toggle){flex-direction:column;gap:2px}
/* 展开时与同行的其它页脚按钮共享一行，不再溢出错位 */
.hHd-Xa_footerActions:has(.ds-s-toggle){align-items:center;gap:2px}
.hHd-Xa_footerActions:has(.ds-s-toggle) > :not(.ds-s-toggle){flex:1 1 0!important;width:auto!important;min-width:0!important}
.ds-s-sec{display:flex;flex-direction:column;gap:12px;min-height:0;color:var(--dsw-alias-label-primary,#262a33);font-size:14px;line-height:22px}
.ds-s-sec-head{}
.ds-s-sec-title{font-size:16px;font-weight:600;line-height:24px}
.ds-s-sec-sub{color:var(--dsw-alias-label-secondary,rgba(38,42,51,.66));font-size:13px;margin-top:2px}
.ds-s-sec-tools{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.ds-s-check{accent-color:#e5484d;width:16px;height:16px;cursor:pointer;margin:0}
.ds-s-toggle-all{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;user-select:none}
.ds-s-btn{box-sizing:border-box;cursor:pointer;border:1px solid rgba(127,127,127,.30);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#262a33);padding:5px 12px;font:inherit;font-size:13px;line-height:18px}
.ds-s-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.ds-s-btn:disabled{opacity:.45;cursor:default}
.ds-s-btn.ds-s-primary{border-color:transparent;background:#e5484d;color:#fff}
.ds-s-btn.ds-s-primary:hover:not(:disabled){background:#d13a40}
.ds-s-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:52vh}
.ds-s-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07))}
.ds-s-row:hover{background:var(--dsw-alias-bg-layer-1-hover,rgba(127,127,127,.13))}
.ds-s-row-info{min-width:0;flex:1}
.ds-s-row-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ds-s-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(38,42,51,.66));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.ds-s-row-err{color:#cf353b;font-size:12px;margin-top:4px;display:none}
.ds-s-preview{flex:1 0 100%;order:9;box-sizing:border-box;margin-top:8px;max-height:140px;overflow:auto;padding:10px;border:1px dashed rgba(127,127,127,.45);border-radius:10px;background:var(--dsw-alias-bg-layer-0,rgba(127,127,127,.05))}
.ds-s-preview-cap{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(38,42,51,.55))}
.ds-s-empty{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07));border-radius:12px;padding:18px 16px;color:var(--dsw-alias-label-secondary,rgba(38,42,51,.66));font-size:13px}
.ds-s-hintline{color:var(--dsw-alias-label-secondary,rgba(38,42,51,.55));font-size:12px}`

		function injectCss() {
			if (typeof document === 'undefined') return
			const tagId = NS + '/styles'
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
			const tag = document.createElement('style')
			tag.dataset.plugin = NS
			tag.dataset.pluginCss = tagId
			tag.textContent = CSS_TEXT
			document.head.appendChild(tag)
		}

		/* ── engine lifecycle ──────────────────────────────────────────────── */

		function engineStart() {
			loadRecords()
			document.addEventListener('contextmenu', onContextMenu, true)
			document.addEventListener('pointermove', onPointerMove, true)
			document.addEventListener('keydown', onKeyDown, true)
			window.addEventListener('scroll', onScrollOrResize, true)
			window.addEventListener('resize', onScrollOrResize)
			const boot = () => {
				ensureObserver()
				scheduleSweep()
			}
			if (document.readyState === 'loading') {
				document.addEventListener('DOMContentLoaded', boot)
			} else {
				boot()
			}
			// Late sweep: the shell finishes mounting after boot, elements the
			// records target may only exist then.
			setTimeout(boot, 1500)
		}
		function engineStop() {
			destroyed = true
			document.removeEventListener('contextmenu', onContextMenu, true)
			document.removeEventListener('pointermove', onPointerMove, true)
			document.removeEventListener('keydown', onKeyDown, true)
			window.removeEventListener('scroll', onScrollOrResize, true)
			window.removeEventListener('resize', onScrollOrResize)
			if (observer) { observer.disconnect(); observer = null }
			if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0 }
			if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = 0 }
			state.active = false
			hideHighlight()
			removeHint()
		}

		/* ── debug/test hook (opt-in for fixtures; absent in normal runtime) ── */

		function installTestHook() {
			if (typeof window === 'undefined' || !window.__DSH_SIMPLIFY_ENABLE_TEST__) return
			window.__dshSimplifyTest = {
				enter: enterCleanMode,
				exit: exitCleanMode,
				toggle: toggleCleanMode,
				removeElement,
				restoreById,
				restoreChecked,
				sweep,
				renderSection,
				records: () => state.records.map((r) => ({ ...r })),
				active: () => state.active,
				clear: () => { state.records = []; state.checked.clear(); schedulePersist(); notify() },
			}
		}

		/* ── plugin entry ──────────────────────────────────────────────────── */

		const inject = ['slots']

		function apply(ctx) {
			injectCss()
			engineStart()
			installTestHook()
			ctx.effect(() => engineStop, 'dsh-simplify: engine lifecycle')

			// Sidebar toggle: renders in the footer-actions row above the settings gear.
			ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
				name: 'sidebar.footer.action',
				id: 'dsh-simplify-toggle',
				order: 10,
				label: () => '简化',
			}, SimplifyToggle))

			// Settings nav entry "简化" + the restore list page.
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'simplify',
				order: 45,
				label: () => '简化',
			}, SimplifySection))
		}

		exports.name = 'dsh-simplify'
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})