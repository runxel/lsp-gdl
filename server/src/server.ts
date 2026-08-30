/**
 * GDL Language Server.
 *
 * Entry point and LSP plumbing only — all language knowledge lives in
 * `gdl/` (model) and `providers/` (features).
 */

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	ResponseError,
	ErrorCodes,
	type TextDocumentIdentifier,
	type DocumentDiagnosticReport,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze, type GdlDocument } from './gdl/analyzer';
import { invalidateLibPartCache } from './gdl/libpart';
import { setReferenceRoot } from './gdl/referenceDocs';
import { provideCompletion, resolveCompletion } from './providers/completion';
import { provideDefinition } from './providers/definition';
import { provideHover } from './providers/hover';
import { provideDiagnostics } from './providers/diagnostics';
import { provideFormattingEdits, type AlignOptions } from './providers/format';
import { provideScriptEndMarkers } from './providers/markers';
import { provideRename, resolveRenameTarget, RenameError, type TextResolver } from './providers/rename';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/**
 * Supplies the current text of any file in the workspace.
 *
 * Rename and master-script completion both reach into sibling scripts of the
 * same library part. Unsaved editor content wins over what is on disk, so
 * neither can act on a stale copy of a file the user is midway through editing.
 * Callers fall back to reading from disk when a file is not open.
 */
const resolveText: TextResolver = (uri) => documents.get(uri)?.getText();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

interface GdlSettings {
	maxNumberOfProblems: number;
}

const defaultSettings: GdlSettings = { maxNumberOfProblems: 200 };
let globalSettings: GdlSettings = defaultSettings;
const documentSettings = new Map<string, Thenable<GdlSettings>>();

/**
 * Analysis cache, keyed by document URI and invalidated by version.
 * Every provider needs the same parse, so doing it once per edit matters.
 */
const analysisCache = new Map<string, { version: number; doc: GdlDocument }>();

function getAnalysis(textDocument: TextDocument): GdlDocument {
	const cached = analysisCache.get(textDocument.uri);
	if (cached && cached.version === textDocument.version) return cached.doc;

	const doc = analyze(textDocument.uri, textDocument.getText());
	analysisCache.set(textDocument.uri, { version: textDocument.version, doc });
	return doc;
}

interface GdlInitializationOptions {
	/**
	 * `VSCodeRef/reference` inside the installed GRAPHISOFT extension, which
	 * hover reads keyword documentation from. Resolved by the client, since
	 * only it knows where VS Code put that extension.
	 */
	referenceRoot?: string;
}

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	hasConfigurationCapability = !!capabilities.workspace?.configuration;
	hasWorkspaceFolderCapability = !!capabilities.workspace?.workspaceFolders;

	setReferenceRoot((params.initializationOptions as GdlInitializationOptions | undefined)?.referenceRoot);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: true,
				// `_` and `.` are ordinary identifier characters in GDL, so they
				// must not re-trigger completion.
				triggerCharacters: [],
			},
			hoverProvider: true,
			definitionProvider: true,
			// Alignment only — see `providers/format.ts`. Registering it here is
			// what gives Format Document, Format Selection and `formatOnSave`
			// their edits; the `GDL: Align argument lists` command asks this
			// server directly, so it works whatever the default formatter is.
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true,
			renameProvider: { prepareProvider: true },
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false,
			},
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = { workspaceFolders: { supported: true } };
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(() => {
			invalidateLibPartCache();
		});
	}
});

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = (change.settings?.gdl as GdlSettings) ?? defaultSettings;
	}
	connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<GdlSettings> {
	if (!hasConfigurationCapability) return Promise.resolve(globalSettings);

	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace
			.getConfiguration({ scopeUri: resource, section: 'gdl' })
			.then((cfg: Partial<GdlSettings> | null) => ({ ...defaultSettings, ...(cfg ?? {}) }));
		documentSettings.set(resource, result);
	}
	return result;
}

documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
	analysisCache.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) {
		return { kind: DocumentDiagnosticReportKind.Full, items: [] } satisfies DocumentDiagnosticReport;
	}
	const settings = await getDocumentSettings(textDocument.uri);
	const doc = getAnalysis(textDocument);
	return {
		kind: DocumentDiagnosticReportKind.Full,
		items: provideDiagnostics(doc, textDocument, settings.maxNumberOfProblems, resolveText),
	} satisfies DocumentDiagnosticReport;
});

connection.onCompletion((params): CompletionItem[] => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return [];
	return provideCompletion(getAnalysis(textDocument), resolveText);
});

connection.onCompletionResolve((item): CompletionItem => {
	const uri = (item.data as { uri?: string } | undefined)?.uri;
	const textDocument = uri ? documents.get(uri) : undefined;
	return resolveCompletion(item, textDocument ? getAnalysis(textDocument) : undefined);
});

connection.onHover((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	return provideHover(getAnalysis(textDocument), textDocument, params.position, resolveText);
});

connection.onDefinition((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	return provideDefinition(getAnalysis(textDocument), textDocument, params.position);
});

connection.onPrepareRename((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	try {
		const target = resolveRenameTarget(
			getAnalysis(textDocument),
			textDocument,
			params.position,
			resolveText,
		);
		return { range: target.range, placeholder: target.name };
	} catch (error) {
		if (error instanceof RenameError) {
			// Reported as a failed prepare so VS Code shows the reason inline.
			throw new ResponseError(ErrorCodes.InvalidRequest, error.message);
		}
		throw error;
	}
});

connection.onRenameRequest((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	try {
		return provideRename(
			getAnalysis(textDocument),
			textDocument,
			params.position,
			params.newName,
			resolveText,
		);
	} catch (error) {
		if (error instanceof RenameError) {
			throw new ResponseError(ErrorCodes.InvalidRequest, error.message);
		}
		throw error;
	}
});

/**
 * The editor's own tab settings, which the alignment padding follows.
 *
 * `FormattingOptions` is required by the protocol, but a client that leaves a
 * field out should not silently get spaces in a tabs file — the repo, and every
 * HSF script in it, is tabs at four.
 */
function alignOptions(options: Partial<AlignOptions> | undefined): AlignOptions {
	return {
		tabSize: options?.tabSize ?? 4,
		insertSpaces: options?.insertSpaces ?? false,
	};
}

connection.onDocumentFormatting((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	return provideFormattingEdits(getAnalysis(textDocument), textDocument, alignOptions(params.options));
});

connection.onDocumentRangeFormatting((params) => {
	const textDocument = documents.get(params.textDocument.uri);
	if (!textDocument) return null;
	return provideFormattingEdits(
		getAnalysis(textDocument),
		textDocument,
		alignOptions(params.options),
		params.range,
	);
});

/**
 * `gdl/scriptEndMarkers` — the lines a script stops on.
 *
 * Not an LSP request, because the protocol has no notion of an editor
 * decoration and VS Code exposes no minimap API at all; the client draws the
 * rule itself and only needs telling where. Finding the terminator is language
 * knowledge all the same — `END` inside a comment, a string or a banner is not
 * one — so it is answered here from the shared analysis cache rather than by a
 * regex on the client, and costs nothing beyond the parse every other provider
 * already asked for.
 */
connection.onRequest(
	'gdl/scriptEndMarkers',
	(params: { textDocument: TextDocumentIdentifier }) => {
		const textDocument = documents.get(params.textDocument.uri);
		if (!textDocument) return [];
		return provideScriptEndMarkers(getAnalysis(textDocument), textDocument);
	},
);

connection.onDidChangeWatchedFiles(() => {
	// paramlist.xml or libpartdata.xml changed on disk — drop cached parameters.
	invalidateLibPartCache();
	connection.languages.diagnostics.refresh();
});

documents.listen(connection);
connection.listen();
