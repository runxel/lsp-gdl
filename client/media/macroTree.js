// @ts-check
/*
 * The Called Macros tree, in the view's webview.
 *
 * Draws the tree the server built (`gdl/macroTree`) and reports clicks back to
 * the extension, which opens files. Which branches are open, and which row is
 * selected, is remembered per root script in the webview's state, so a redraw
 * after an edit — or coming back to a script — leaves the tree as it was.
 *
 * Mouse:    click opens the macro's script as a preview; double-click keeps it
 *           open; the box toggles; Alt-click, or the arrow at the row's end,
 *           goes to the call instead — and, for a macro called more than once,
 *           to the next call each time, wrapping round after the last.
 * Keyboard: ↑ ↓ Home End move; → opens a branch or steps into it; ← closes it
 *           or steps out; + − toggle and * opens everything below, as in the
 *           classic tree; Space previews, Enter opens.
 */

(function () {
	const vscode = acquireVsCodeApi();

	/** @type {{ roots: Record<string, { expanded: string[], selected?: string }> }} */
	const state = vscode.getState() || { roots: {} };

	const treeEl = /** @type {HTMLElement} */ (document.getElementById('tree'));
	const emptyEl = /** @type {HTMLElement} */ (document.getElementById('empty'));
	const noteEl = /** @type {HTMLElement} */ (document.getElementById('note'));

	const SCRIPT_LABELS = {
		'1d': 'master script',
		'2d': '2D script',
		'3d': '3D script',
		vl: 'parameter script',
		ui: 'interface script',
		pr: 'properties script',
		fwm: 'forward migration script',
		bwm: 'backward migration script',
	};

	/** Monochrome 16×16 glyphs, drawn in `currentColor`. */
	const ICONS = {
		// A script file, for the root.
		root: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/><path d="M6 8h5M6 10h5M6 12h3"/></svg>',
		// A library part: a box, as Archicad draws an object.
		source: '<svg viewBox="0 0 16 16"><path d="M8 1.8 14 5v6.2L8 14.4 2 11.2V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6.2"/></svg>',
		binary: '<svg viewBox="0 0 16 16"><path d="M8 1.8 14 5v6.2L8 14.4 2 11.2V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6.2"/></svg>',
		missing: '<svg viewBox="0 0 16 16" stroke-dasharray="1.6 1.4"><path d="M8 1.8 14 5v6.2L8 14.4 2 11.2V5z"/></svg>',
		// A name that only running the script could tell.
		computed: '<svg viewBox="0 0 16 16"><path d="M5 2.5C3.5 2.5 3.5 4 3.5 5.5S2.5 8 2 8c.5 0 1.5.5 1.5 2.5s0 3 1.5 3M11 2.5c1.5 0 1.5 1.5 1.5 3S13.5 8 14 8c-.5 0-1.5.5-1.5 2.5s0 3-1.5 3"/><path d="M6.5 6l3 4M9.5 6l-3 4"/></svg>',
		// Already on the path: calling it again goes round in a circle.
		recursive: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M11.8 1.8l-.3 2.8 2.8.2"/></svg>',
	};

	const GOTO_ICON = '<svg viewBox="0 0 16 16"><path d="M13.5 3v4.5a2 2 0 0 1-2 2H3"/><path d="M6 6.5 3 9.5l3 3"/></svg>';

	/** @type {any} */
	let tree;
	/** @type {Set<string>} */
	let expanded = new Set(['']);
	/** @type {string | undefined} */
	let selected;
	/** @type {Map<string, any>} */
	const nodesByKey = new Map();
	/**
	 * The call each node last went to, by key. Kept across redraws, so an
	 * edit does not send the next click back to the first call; forgotten
	 * with the root.
	 * @type {Map<string, number>}
	 */
	const lastCall = new Map();

	/** Scripts remembered at most; the oldest is forgotten first. */
	const REMEMBERED = 50;

	function save() {
		if (!tree) return;
		delete state.roots[tree.uri];
		state.roots[tree.uri] = { expanded: [...expanded], selected };
		const uris = Object.keys(state.roots);
		for (const uri of uris.slice(0, Math.max(0, uris.length - REMEMBERED))) delete state.roots[uri];
		vscode.setState(state);
	}

	function keyOf(parentKey, node) {
		const part = node.status === 'computed'
			? '$' + String(node.variable || node.name).toLowerCase()
			: String(node.name).toLowerCase();
		return parentKey + '/' + part;
	}

	function describe(node) {
		const bits = [];
		switch (node.status) {
			case 'missing': bits.push('not in workspace'); break;
			case 'binary': bits.push('.gsm only'); break;
			case 'computed': bits.push('computed'); break;
			case 'recursive': bits.push('recursive'); break;
		}
		if (node.spelling === 'variable' && node.variable) bits.push('via ' + node.variable);
		// A macro's children come from its master as well as its own script;
		// say which, since it is the one that is not opened.
		if (node.depth > 1 && node.from === '1d' && tree.script !== '1d') bits.push('master');
		return bits;
	}

	/** The call a node last went to, unless an edit has since removed it. */
	function lastOf(node, key) {
		const at = lastCall.get(key);
		return at !== undefined && at < node.callSites.length ? at : undefined;
	}

	/** `×3` until the calls are being stepped through, then `2/3`. */
	function callCount(node, key) {
		const n = node.callSites ? node.callSites.length : 0;
		if (n < 2) return '';
		const at = lastOf(node, key);
		// Escaped, so the page reads the same whatever charset it is served in.
		return at === undefined ? '\u00d7' + n : (at + 1) + '/' + n;
	}

	function descText(node, key) {
		return [...node.desc, callCount(node, key)].filter(Boolean).join(' \u00b7 ');
	}

	/** The call the go-to button reaches next. */
	function nextCall(node, key) {
		const at = lastOf(node, key);
		return at === undefined ? 0 : (at + 1) % node.callSites.length;
	}

	function gotoTitle(node, key) {
		const n = node.callSites.length;
		const next = nextCall(node, key);
		const line = node.callSites[next].line + 1;
		return n > 1
			? 'Go to call ' + (next + 1) + ' of ' + n + ', line ' + line
			: 'Go to the call, line ' + line;
	}

	function tooltip(node) {
		const lines = [node.name];
		switch (node.status) {
			case 'source': if (node.uri) lines.push('Opens ' + decodeURIComponent(node.uri.replace(/^file:\/\//, ''))); break;
			case 'recursive': lines.push('Already called further up this branch'); break;
			case 'binary': lines.push('Only the compiled library part is in the workspace: ' + node.path); break;
			case 'missing': lines.push('No library part of this name in the workspace'); break;
			case 'computed': lines.push('The name is held in `' + node.variable + '`, and nothing in reach assigns it one'); break;
		}
		const where = SCRIPT_LABELS[node.from] || 'script';
		const sites = node.callSites;
		lines.push(sites.length > 1
			? 'Called ' + sites.length + ' times, first from the ' + where + ', line ' + (sites[0].line + 1)
			: 'Called from the ' + where + ', line ' + (sites[0].line + 1));
		if (node.spelling === 'variable') lines.push('Through the variable ' + node.variable);
		if (node.alternatives > 0) {
			lines.push(node.alternatives === 1
				? 'One other copy of this name is in the workspace; the nearest is shown'
				: node.alternatives + ' other copies of this name are in the workspace; the nearest is shown');
		}
		lines.push(sites.length > 1
			? 'Alt-click to go to the calls, one at a time'
			: 'Alt-click to go to the call');
		return lines.join('\n');
	}

	function renderNode(node, key, depth, isChild) {
		nodesByKey.set(key, node);
		const li = document.createElement('li');
		li.setAttribute('role', 'treeitem');
		li.setAttribute('aria-level', String(depth + 1));
		li.setAttribute('aria-selected', String(key === selected));
		li.tabIndex = -1;
		li.dataset.key = key;
		li.className = 'status-' + node.status + (isChild ? ' child' : '');
		li.style.setProperty('--depth', String(depth));

		const hasChildren = node.children && node.children.length > 0;
		if (hasChildren) li.setAttribute('aria-expanded', String(expanded.has(key)));

		const row = document.createElement('div');
		row.className = 'row';
		row.title = node.tooltip;

		const gutter = document.createElement('span');
		gutter.className = 'gutter';
		const box = document.createElement('span');
		box.className = 'box';
		gutter.appendChild(box);

		const icon = document.createElement('span');
		icon.className = 'icon';
		icon.innerHTML = ICONS[node.status] || ICONS.source;

		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = node.name;

		row.append(gutter, icon, label);

		const text = typeof node.desc === 'string' ? node.desc : descText(node, key);
		if (text) {
			const desc = document.createElement('span');
			desc.className = 'desc';
			desc.textContent = text;
			row.appendChild(desc);
		}

		if (node.callSites && node.callSites.length > 0) {
			const go = document.createElement('button');
			go.className = 'goto';
			go.tabIndex = -1;
			go.title = gotoTitle(node, key);
			go.setAttribute('aria-label', go.title);
			go.innerHTML = GOTO_ICON;
			row.appendChild(go);
		}

		li.appendChild(row);

		if (hasChildren) {
			const group = document.createElement('ul');
			group.setAttribute('role', 'group');
			group.hidden = !expanded.has(key);
			for (const child of node.children) {
				group.appendChild(renderNode(child, keyOf(key, child), depth + 1, true));
			}
			li.appendChild(group);
		}
		return li;
	}

	/** Annotates the server's tree with what the page needs, once per message. */
	function prepare(node, depth) {
		node.depth = depth;
		if (depth > 0) {
			node.desc = describe(node);
			node.tooltip = tooltip(node);
		}
		for (const child of node.children || []) prepare(child, depth + 1);
	}

	function render() {
		const hadFocus = treeEl.contains(document.activeElement);
		nodesByKey.clear();
		treeEl.textContent = '';
		emptyEl.hidden = true;

		const rootNode = {
			name: tree.name,
			status: 'root',
			uri: tree.uri,
			children: tree.children,
			desc: SCRIPT_LABELS[tree.script] || '',
			tooltip: tree.name + '\n' + decodeURIComponent(tree.uri.replace(/^file:\/\//, '')),
		};
		for (const child of rootNode.children) prepare(child, 1);

		const list = document.createElement('ul');
		list.appendChild(renderNode(rootNode, '', 0, false));
		treeEl.appendChild(list);

		if (tree.children.length === 0) {
			noteEl.textContent = 'This script calls no macros.';
			noteEl.hidden = false;
		} else if (tree.truncated) {
			noteEl.textContent = 'The tree was cut short: it is too large or too deep to follow in full.';
			noteEl.hidden = false;
		} else {
			noteEl.hidden = true;
		}

		if (!selected || !nodesByKey.has(selected)) selected = '';
		const current = itemFor(selected);
		if (current) {
			current.setAttribute('aria-selected', 'true');
			current.tabIndex = 0;
			if (hadFocus) current.focus();
		}
	}

	function showEmpty(reason) {
		tree = undefined;
		nodesByKey.clear();
		treeEl.textContent = '';
		noteEl.hidden = true;
		emptyEl.textContent = reason;
		emptyEl.hidden = false;
	}

	/** @returns {HTMLElement | null} */
	function itemFor(key) {
		return treeEl.querySelector('li[data-key="' + CSS.escape(key) + '"]');
	}

	/** Rows the user can currently see, top to bottom. */
	function visibleItems() {
		return /** @type {HTMLElement[]} */ ([...treeEl.querySelectorAll('li')]).filter((li) => li.offsetParent !== null);
	}

	function select(li, focus = true) {
		if (!li) return;
		for (const other of treeEl.querySelectorAll('li[aria-selected="true"]')) {
			other.setAttribute('aria-selected', 'false');
			/** @type {HTMLElement} */ (other).tabIndex = -1;
		}
		li.setAttribute('aria-selected', 'true');
		li.tabIndex = 0;
		selected = li.dataset.key;
		if (focus) li.focus();
		li.scrollIntoView({ block: 'nearest' });
		save();
	}

	function setExpanded(li, open) {
		if (!li || !li.hasAttribute('aria-expanded')) return;
		const key = li.dataset.key || '';
		li.setAttribute('aria-expanded', String(open));
		const group = li.querySelector(':scope > ul');
		if (group) /** @type {HTMLElement} */ (group).hidden = !open;
		if (open) expanded.add(key);
		else expanded.delete(key);
		save();
	}

	function setSubtree(li, open) {
		setExpanded(li, open);
		for (const inner of li.querySelectorAll('li[aria-expanded]')) setExpanded(/** @type {HTMLElement} */ (inner), open);
	}

	function openNode(li, { preview, callSite }) {
		const key = li.dataset.key || '';
		const node = nodesByKey.get(key);
		if (!node) return;
		if (!callSite && node.uri) {
			vscode.postMessage({ type: 'open', preview, uri: node.uri });
			return;
		}
		const sites = node.callSites;
		if (!sites || sites.length === 0) return;
		// Asked for the call outright, step on to the next one. A plain click on
		// a macro that cannot be read lands on the call only because there is
		// nothing else to open, so it stays where the stepping left off — a
		// double-click being two clicks as well, stepping there would skip two.
		let at;
		if (callSite) {
			at = nextCall(node, key);
			lastCall.set(key, at);
			refreshCount(li, node, key);
		} else {
			at = lastOf(node, key) ?? 0;
		}
		vscode.postMessage({ type: 'open', preview, ...sites[at] });
	}

	/** Updates a row's count and button after stepping to another call. */
	function refreshCount(li, node, key) {
		const row = li.querySelector(':scope > .row');
		if (!row) return;
		const desc = row.querySelector(':scope > .desc');
		if (desc) desc.textContent = descText(node, key);
		const go = row.querySelector(':scope > .goto');
		if (go) {
			/** @type {HTMLElement} */ (go).title = gotoTitle(node, key);
			go.setAttribute('aria-label', gotoTitle(node, key));
		}
	}

	treeEl.addEventListener('click', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);
		const li = /** @type {HTMLElement | null} */ (target.closest('li'));
		if (!li) return;
		if (target.closest('.gutter') && li.hasAttribute('aria-expanded')) {
			select(li);
			setExpanded(li, li.getAttribute('aria-expanded') !== 'true');
			return;
		}
		select(li);
		openNode(li, { preview: true, callSite: event.altKey || !!target.closest('.goto') });
	});

	treeEl.addEventListener('dblclick', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);
		const li = /** @type {HTMLElement | null} */ (target.closest('li'));
		if (!li || target.closest('.goto')) return;
		if (target.closest('.gutter') && li.hasAttribute('aria-expanded')) return;
		openNode(li, { preview: false, callSite: event.altKey });
	});

	treeEl.addEventListener('keydown', (event) => {
		const li = /** @type {HTMLElement | null} */ (document.activeElement && document.activeElement.closest('li'));
		if (!li) return;
		const items = visibleItems();
		const at = items.indexOf(li);
		const isOpen = li.getAttribute('aria-expanded') === 'true';
		const canOpen = li.hasAttribute('aria-expanded');
		const parent = /** @type {HTMLElement | null} */ (li.parentElement && li.parentElement.closest('li'));

		switch (event.key) {
			case 'ArrowDown': select(items[at + 1]); break;
			case 'ArrowUp': select(items[at - 1]); break;
			case 'Home': select(items[0]); break;
			case 'End': select(items[items.length - 1]); break;
			case 'ArrowRight':
				if (canOpen && !isOpen) setExpanded(li, true);
				else if (isOpen) select(/** @type {HTMLElement} */ (li.querySelector(':scope > ul > li')));
				break;
			case 'ArrowLeft':
				if (isOpen) setExpanded(li, false);
				else if (parent) select(parent);
				break;
			case '+': setExpanded(li, true); break;
			case '-': setExpanded(li, false); break;
			case '*': setSubtree(li, true); break;
			case ' ': openNode(li, { preview: true, callSite: event.altKey }); break;
			case 'Enter': openNode(li, { preview: false, callSite: event.altKey }); break;
			default: return;
		}
		event.preventDefault();
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'tree': {
				const changedRoot = !tree || tree.uri !== message.tree.uri;
				tree = message.tree;
				if (changedRoot) {
					lastCall.clear();
					const remembered = state.roots[tree.uri];
					expanded = new Set(remembered ? remembered.expanded : ['']);
					selected = remembered ? remembered.selected : '';
				}
				render();
				save();
				break;
			}
			case 'empty':
				showEmpty(message.reason);
				break;
			case 'expandAll': {
				const root = treeEl.querySelector('li');
				if (root) setSubtree(/** @type {HTMLElement} */ (root), true);
				break;
			}
			case 'collapseAll': {
				const root = /** @type {HTMLElement | null} */ (treeEl.querySelector('li'));
				if (!root) break;
				for (const inner of root.querySelectorAll('li[aria-expanded]')) setExpanded(/** @type {HTMLElement} */ (inner), false);
				// The root stays open: collapsing it would leave one row saying
				// nothing, where its children are the point of the view.
				setExpanded(root, true);
				select(root, false);
				break;
			}
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
