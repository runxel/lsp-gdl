/**
 * VS Code client for the GDL language server.
 */

import * as path from 'path';
import {
	commands,
	extensions,
	window,
	workspace,
	ExtensionContext,
	OverviewRulerLane,
	type TextEditor,
	ThemeColor,
	Uri,
	WorkspaceEdit,
} from 'vscode';

import {
	DocumentFormattingRequest,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	type Range as LspRange,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] },
		},
	};

	// The official extension bundles the reference guide as one HTML page per
	// keyword. It is an `extensionDependency`, so it is installed alongside
	// ours — but only VS Code knows where, hence looking the path up here and
	// handing it to the server rather than vendoring the guide ourselves.
	const official = extensions.getExtension('Graphisoft.gdl');
	const referenceRoot = official
		? Uri.joinPath(official.extensionUri, 'VSCodeRef', 'reference').fsPath
		: undefined;

	const clientOptions: LanguageClientOptions = {
		// `gdl-hsf` is contributed by the official GRAPHISOFT extension, which we
		// complement rather than replace — it owns the grammar, snippets and
		// outline; we add the language-server features on top. See CLAUDE.md.
		documentSelector: [{ scheme: 'file', language: 'gdl-hsf' }],
		synchronize: {
			// A library part's parameters live in paramlist.xml, not in the
			// script — so the server must be told when they change.
			fileEvents: workspace.createFileSystemWatcher('**/{paramlist,libpartdata}.xml'),
		},
		initializationOptions: { referenceRoot },
	};

	client = new LanguageClient('gdl', 'GDL Language Server', serverOptions, clientOptions);

	context.subscriptions.push(commands.registerCommand('gdl.alignArgumentLists', alignArgumentLists));

	context.subscriptions.push(
		endMarkerDecoration,
		// A new editor has nothing drawn on it yet, and one that just became
		// visible again may have been edited by someone else in the meantime.
		window.onDidChangeVisibleTextEditors(() => void refreshEndMarkers()),
		workspace.onDidChangeTextDocument((event) => {
			if (event.document.languageId === 'gdl-hsf') scheduleEndMarkers();
		}),
		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('gdl.showScriptEndMarkers')) void refreshEndMarkers();
		}),
	);

	// The server cannot answer until it is up, so the first draw waits for it
	// rather than racing it and silently leaving the open file unmarked. A
	// failed start reports itself in the client's own output channel; there is
	// simply nothing to draw, so it is swallowed here.
	void client.start().then(
		() => refreshEndMarkers(),
		() => undefined,
	);
}

/**
 * `END` / `EXIT` markers.
 *
 * Asked for as a line in the minimap, which cannot be done: VS Code exposes no
 * minimap API to extensions — the word does not appear once in `vscode.d.ts`.
 * The editor core can mark the minimap (that is how find matches and errors get
 * their ticks) but it has never been mapped onto `DecorationRenderOptions`.
 *
 * So the line is drawn in the two places that *are* reachable, from one
 * decoration: a rule across the text at the terminator, and a tick spanning the
 * overview ruler — the strip the minimap sits in, a few pixels to its right.
 * `ThemeColor` rather than a literal colour, so both survive a theme switch.
 */
const endMarkerDecoration = window.createTextEditorDecorationType({
	isWholeLine: true,
	borderStyle: 'solid',
	// Under the line, not over it: the rule closes the statement off, and a
	// wrapped return list means the line it closes is the last row of the
	// list rather than the row the `END` itself is on.
	borderWidth: '0 0 1px 0',
	borderColor: new ThemeColor('editorLineNumber.foreground'),
	overviewRulerLane: OverviewRulerLane.Full,
	overviewRulerColor: new ThemeColor('editorLineNumber.foreground'),
});

let endMarkerTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Coalesces the redraws while someone is typing.
 *
 * The server answers from its analysis cache, so a request per keystroke would
 * not be expensive — but it would be a round trip per keystroke, and a rule that
 * flickers as the line under it is edited is worse than one that settles.
 */
function scheduleEndMarkers(): void {
	if (endMarkerTimer) clearTimeout(endMarkerTimer);
	endMarkerTimer = setTimeout(() => void refreshEndMarkers(), 200);
}

async function refreshEndMarkers(): Promise<void> {
	if (!client?.isRunning()) return;

	// Every visible editor, not just the active one: a split view shows two
	// scripts at once and the inactive half must not keep a stale rule.
	for (const editor of window.visibleTextEditors) {
		if (editor.document.languageId !== 'gdl-hsf') continue;
		await drawEndMarkers(editor);
	}
}

async function drawEndMarkers(editor: TextEditor): Promise<void> {
	const enabled = workspace
		.getConfiguration('gdl', editor.document)
		.get<boolean>('showScriptEndMarkers', true);
	if (!enabled) {
		editor.setDecorations(endMarkerDecoration, []);
		return;
	}

	const ranges = await client.sendRequest<LspRange[]>('gdl/scriptEndMarkers', {
		textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(editor.document),
	});
	editor.setDecorations(endMarkerDecoration, await client.protocol2CodeConverter.asRanges(ranges));
}

/**
 * `GDL: Align argument lists` — the same edits Format Document produces, asked
 * for by name.
 *
 * It goes straight to our server rather than through `editor.action.formatDocument`
 * because VS Code allows one default formatter per language: if anything else
 * ever registers for `gdl-hsf`, the built-in command would run that one instead,
 * and a command called "align argument lists" doing something else entirely is
 * the worst outcome available.
 */
async function alignArgumentLists(): Promise<void> {
	const editor = window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'gdl-hsf') return;
	if (!client?.isRunning()) return;

	const document = editor.document;
	const edits = await client.sendRequest(DocumentFormattingRequest.type, {
		textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
		// The editor's own settings, so the padding matches the file it lands in.
		options: {
			tabSize: Number(editor.options.tabSize) || 4,
			insertSpaces: editor.options.insertSpaces === true,
		},
	});
	if (!edits?.length) return;

	// One workspace edit, so the whole alignment is a single undo step.
	const workspaceEdit = new WorkspaceEdit();
	workspaceEdit.set(document.uri, await client.protocol2CodeConverter.asTextEdits(edits));
	await workspace.applyEdit(workspaceEdit);
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}
