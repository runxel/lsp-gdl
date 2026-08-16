/**
 * VS Code client for the GDL language server.
 */

import * as path from 'path';
import { extensions, workspace, ExtensionContext, Uri } from 'vscode';

import {
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
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}
