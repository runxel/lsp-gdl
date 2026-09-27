/**
 * The *Called Macros* view: the macros the active script calls, followed
 * through the workspace, drawn as a classic tree.
 *
 * A webview rather than a `TreeView`, because what was asked for is the file
 * browser's own drawing — `+`/`−` boxes and dotted connector lines — and a
 * native tree offers neither: it draws chevrons, and its indent guides are
 * solid and follow the user's `workbench.tree.renderIndentGuides`, not ours.
 *
 * All the language knowledge is the server's (`gdl/macroTree`); this side only
 * decides *which* script the tree is about, and opens what is clicked.
 *
 * **Clicking a macro must not re-root the tree.** Opening a macro makes its
 * script the active editor, and following the active editor naively would
 * replace the tree the user was walking with the macro's own — the view
 * would jump out from under the next click. So a file opened *from* the view
 * is remembered, and becoming active does not move the root; switching to any
 * other GDL editor does.
 */

import { randomBytes } from 'node:crypto';
import {
	commands,
	window,
	workspace,
	Disposable,
	Position,
	Range,
	Uri,
	type ExtensionContext,
	type TextDocument,
	type Webview,
	type WebviewView,
	type WebviewViewProvider,
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export const MACRO_VIEW_ID = 'gdl.calledMacros';

/** Messages the page sends. */
type FromView =
	| { type: 'ready' }
	| { type: 'open'; uri: string; line?: number; character?: number; preview: boolean };

export class MacroTreeView implements WebviewViewProvider, Disposable {
	private view: WebviewView | undefined;
	/** The script the tree is about. */
	private root: Uri | undefined;
	/** Opened from the view, so becoming active must not move the root. */
	private openedFromView: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: Disposable[] = [];

	constructor(
		private readonly context: ExtensionContext,
		private readonly client: () => LanguageClient | undefined,
	) {
		const active = window.activeTextEditor?.document;
		if (active?.languageId === 'gdl-hsf') this.root = active.uri;

		this.disposables.push(
			window.registerWebviewViewProvider(MACRO_VIEW_ID, this),
			commands.registerCommand('gdl.calledMacros.refresh', () => void this.refresh()),
			commands.registerCommand('gdl.calledMacros.expandAll', () => this.post({ type: 'expandAll' })),
			commands.registerCommand('gdl.calledMacros.collapseAll', () => this.post({ type: 'collapseAll' })),
			window.onDidChangeActiveTextEditor((editor) => {
				const document = editor?.document;
				// A non-GDL editor — the output panel, a `paramlist.xml` —
				// leaves the last tree standing, as the Outline does not; the
				// tree is still the one wanted when the user comes back.
				if (!document || document.languageId !== 'gdl-hsf') return;
				const uri = document.uri.toString();
				if (uri === this.openedFromView) {
					this.openedFromView = undefined;
					return;
				}
				this.openedFromView = undefined;
				if (uri === this.root?.toString()) return;
				this.root = document.uri;
				void this.refresh();
			}),
			// The root's own edits redraw it; a save anywhere may change a
			// macro further down, which is read from disk.
			workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.toString() === this.root?.toString()) this.schedule();
			}),
			workspace.onDidSaveTextDocument((document: TextDocument) => {
				if (document.languageId === 'gdl-hsf') this.schedule();
			}),
			// A part created or removed changes what a call resolves to.
			(() => {
				const watcher = workspace.createFileSystemWatcher('**/{libpartdata.xml,*.gsm,*.GSM}', false, true, false);
				watcher.onDidCreate(() => this.schedule());
				watcher.onDidDelete(() => this.schedule());
				return watcher;
			})(),
		);
	}

	resolveWebviewView(view: WebviewView): void {
		this.view = view;
		const media = Uri.joinPath(this.context.extensionUri, 'client', 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);

		view.webview.onDidReceiveMessage((message: FromView) => {
			if (message.type === 'ready') void this.refresh();
			else if (message.type === 'open') void this.open(message);
		}, undefined, this.disposables);
		// Nothing is drawn while hidden, so catch up on becoming visible.
		view.onDidChangeVisibility(() => {
			if (view.visible) void this.refresh();
		}, undefined, this.disposables);
		view.onDidDispose(() => (this.view = undefined), undefined, this.disposables);
	}

	/** Called once the language client is running. */
	serverReady(): void {
		void this.refresh();
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.refresh(), 400);
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	async refresh(): Promise<void> {
		if (!this.view?.visible) return;
		const client = this.client();
		if (!this.root) {
			this.post({ type: 'empty', reason: 'Open a GDL script to see the macros it calls.' });
			return;
		}
		if (!client?.isRunning()) {
			this.post({ type: 'empty', reason: 'Waiting for the GDL language server…' });
			return;
		}

		// The server answers for documents it has open; the root may have been
		// closed since it became the root, in which case it is opened again
		// quietly — without an editor — so the tree does not vanish.
		const root = this.root;
		await workspace.openTextDocument(root).then(undefined, () => undefined);
		try {
			const tree = await client.sendRequest('gdl/macroTree', {
				textDocument: { uri: client.code2ProtocolConverter.asUri(root) },
			});
			if (root !== this.root) return;
			if (tree) this.post({ type: 'tree', tree });
			else this.post({ type: 'empty', reason: 'This script could not be read.' });
		} catch {
			this.post({ type: 'empty', reason: 'The language server could not build the tree.' });
		}
	}

	private async open(message: Extract<FromView, { type: 'open' }>): Promise<void> {
		const uri = Uri.parse(message.uri);
		if (uri.toString() !== this.root?.toString()) this.openedFromView = uri.toString();
		const at = message.line !== undefined
			? new Position(message.line, message.character ?? 0)
			: undefined;
		try {
			await window.showTextDocument(uri, {
				preview: message.preview,
				// Keep focus in the view on a single click, as the Explorer does,
				// so the arrow keys go on walking the tree.
				preserveFocus: message.preview,
				...(at ? { selection: new Range(at, at) } : {}),
			});
		} catch {
			this.openedFromView = undefined;
			void window.showWarningMessage(`Could not open ${uri.fsPath}.`);
		}
	}

	private html(webview: Webview, media: Uri): string {
		const nonce = randomBytes(16).toString('hex');
		const css = webview.asWebviewUri(Uri.joinPath(media, 'macroTree.css'));
		const js = webview.asWebviewUri(Uri.joinPath(media, 'macroTree.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Called Macros</title>
</head>
<body>
<div id="tree" role="tree" aria-label="Called macros"></div>
<p id="empty" hidden></p>
<p id="note" hidden></p>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		for (const d of this.disposables) d.dispose();
	}
}
