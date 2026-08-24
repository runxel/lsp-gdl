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
	Uri,
	WorkspaceEdit,
} from 'vscode';

import {
	DocumentFormattingRequest,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
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
	client.start();

	context.subscriptions.push(commands.registerCommand('gdl.alignArgumentLists', alignArgumentLists));
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
