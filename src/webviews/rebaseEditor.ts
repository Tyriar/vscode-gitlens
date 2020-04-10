'use strict';
import * as paths from 'path';
import * as fs from 'fs';
import {
	CancellationToken,
	commands,
	CustomTextEditorProvider,
	Disposable,
	Position,
	Range,
	TextDocument,
	Uri,
	WebviewPanel,
	window,
	workspace,
	WorkspaceEdit,
} from 'vscode';
import {
	IpcMessage,
	onIpcCommand,
	ReadyCommandType,
	RebaseDidAbortCommandType,
	RebaseDidChangeEntryCommandType,
	RebaseDidChangeNotificationType,
	RebaseDidMoveEntryCommandType,
	RebaseDidStartCommandType,
	RebaseEntry,
	RebaseEntryAction,
	RebaseEntryCommit,
	RebaseState,
} from './protocol';
import { Container } from '../container';
import { Logger } from '../logger';
import { Commands, ShowQuickCommitDetailsCommand } from '../commands';

let ipcSequence = 0;
function nextIpcId() {
	if (ipcSequence === Number.MAX_SAFE_INTEGER) {
		ipcSequence = 1;
	} else {
		ipcSequence++;
	}

	return `host:${ipcSequence}`;
}

const rebaseRegex = /^\s?#\s?Rebase\s([0-9a-f]+?)..([0-9a-f]+?)\sonto\s([0-9a-f]+?)\s.*$/gim;
const rebaseCommandsRegex = /^\s?(p|pick|r|reword|e|edit|s|squash|f|fixup|b|break|d|drop)\s([0-9a-f]+?)\s(.*)$/gm;

const rebaseActionsMap = new Map<string, RebaseEntryAction>([
	['p', 'pick'],
	['pick', 'pick'],
	['r', 'reword'],
	['reword', 'reword'],
	['e', 'edit'],
	['edit', 'edit'],
	['s', 'squash'],
	['squash', 'squash'],
	['f', 'fixup'],
	['fixup', 'fixup'],
	['b', 'break'],
	['break', 'break'],
	['d', 'drop'],
	['drop', 'drop'],
]);

export class RebaseEditorProvider implements CustomTextEditorProvider, Disposable {
	private readonly _disposable: Disposable;

	constructor() {
		this._disposable = Disposable.from(
			window.registerCustomEditorProvider('gitlens.rebase', this, {
				webviewOptions: {
					enableFindWidget: true,
				},
			}),
		);
	}

	dispose() {
		this._disposable && this._disposable.dispose();
	}

	async resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel, token: CancellationToken) {
		const disposables: Disposable[] = [];

		disposables.push(panel.onDidDispose(() => disposables.forEach(d => d.dispose())));

		panel.webview.options = { enableScripts: true };

		disposables.push(panel.webview.onDidReceiveMessage(e => this.onMessageReceived(document, panel, e)));

		disposables.push(
			workspace.onDidChangeTextDocument(e => {
				if (e.contentChanges.length === 0 || e.document.uri.toString() !== document.uri.toString()) return;

				this.parseDocumentAndSendChange(panel, document);
			}),
		);

		panel.webview.html = await this.getHtml(document);
	}

	private async parseState(document: TextDocument): Promise<RebaseState> {
		const repoPath = await Container.git.getRepoPath(paths.join(document.uri.fsPath, '../../..'));

		const contents = document.getText();

		const commits: RebaseEntryCommit[] = [];
		const entries: RebaseEntry[] = [];

		const branch = await Container.git.getBranch(repoPath);

		let match;
		match = rebaseRegex.exec(contents);
		const [, from, to, onto] = match ?? ['', '', ''];

		let action;
		let ref;
		let message;

		do {
			match = rebaseCommandsRegex.exec(contents);
			if (match == null) break;

			[, action, ref, message] = match;

			entries.push({
				index: match.index,
				action: rebaseActionsMap.get(action) ?? 'pick',
				// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
				ref: ` ${ref}`.substr(1),
				// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
				message: message == null || message.length === 0 ? '' : ` ${message}`.substr(1),
			});

			const commit = await Container.git.getCommit(repoPath!, ref);
			if (commit) {
				commits.push({
					ref: commit.ref,
					author: commit.author,
					avatarUrl: commit.getAvatarUri(Container.config.defaultGravatarsStyle).toString(true),
					date: commit.formatDate(Container.config.defaultDateFormat),
					dateFromNow: commit.formatDateFromNow(),
					email: commit.email,
					message: commit.message,
					command: `command:${Commands.ShowQuickCommitDetails}`, // ShowQuickCommitDetailsCommand.getMarkdownCommandArgs({
					// 	sha: commit.ref,
					// }),
				});
			}
		} while (true);

		return {
			branch: branch?.name ?? '',
			from: from ?? '',
			to: to ?? '',
			onto: onto ?? '',
			entries: entries,
			commits: commits,
		};
	}

	private async parseDocumentAndSendChange(panel: WebviewPanel, document: TextDocument) {
		const state = await this.parseState(document);
		this.postMessage(panel, {
			id: nextIpcId(),
			method: RebaseDidChangeNotificationType.method,
			params: state,
		});
	}

	private async postMessage(panel: WebviewPanel, message: IpcMessage) {
		try {
			const success = await panel.webview.postMessage(message);
			return success;
		} catch (ex) {
			Logger.error(ex);
			return false;
		}
	}

	private onMessageReceived(document: TextDocument, panel: WebviewPanel, e: IpcMessage) {
		switch (e.method) {
			// case ReadyCommandType.method:
			// 	onIpcCommand(ReadyCommandType, e, params => {
			// 		this.parseDocumentAndSendChange(panel, document);
			// 	});

			// 	break;

			case RebaseDidStartCommandType.method:
				onIpcCommand(ReadyCommandType, e, async params => {
					await document.save();
					await commands.executeCommand('workbench.action.closeActiveEditor');
				});

				break;

			case RebaseDidAbortCommandType.method:
				onIpcCommand(ReadyCommandType, e, async params => {
					// Delete the contents to abort the rebase
					const edit = new WorkspaceEdit();
					edit.replace(document.uri, new Range(0, 0, document.lineCount, 0), '');
					await workspace.applyEdit(edit);
					await document.save();
					await commands.executeCommand('workbench.action.closeActiveEditor');
				});

				break;

			case RebaseDidChangeEntryCommandType.method:
				onIpcCommand(RebaseDidChangeEntryCommandType, e, async params => {
					const state = await this.parseState(document);

					const entry = state.entries.find(e => e.ref === params.ref);
					if (entry == null) return;

					const start = document.positionAt(entry.index);
					const range = document.validateRange(
						new Range(new Position(start.line, 0), new Position(start.line, Number.MAX_SAFE_INTEGER)),
					);

					const edit = new WorkspaceEdit();
					edit.replace(document.uri, range, `${params.action} ${entry.ref} ${entry.message}`);
					await workspace.applyEdit(edit);
				});

				break;

			case RebaseDidMoveEntryCommandType.method:
				onIpcCommand(RebaseDidMoveEntryCommandType, e, async params => {
					const state = await this.parseState(document);

					const entry = state.entries.find(e => e.ref === params.ref);
					if (entry == null) return;

					const index = state.entries.findIndex(e => e.ref === params.ref);
					if ((!params.down && index === 0) || (params.down && index === state.entries.length - 1)) {
						return;
					}

					const start = document.positionAt(entry.index);
					const range = document.validateRange(
						new Range(new Position(start.line, 0), new Position(start.line + 1, 0)),
					);

					const edit = new WorkspaceEdit();
					edit.delete(document.uri, range);
					edit.insert(
						document.uri,
						new Position(range.start.line + (params.down ? 2 : -1), 0),
						`${entry.action} ${entry.ref} ${entry.message}\n`,
					);
					await workspace.applyEdit(edit);
				});

				break;
		}
	}

	private _html: string | undefined;
	private async getHtml(document: TextDocument): Promise<string> {
		const filename = Container.context.asAbsolutePath(paths.join('dist/webviews/', 'rebase.html'));

		let content;
		// When we are debugging avoid any caching so that we can change the html and have it update without reloading
		if (Logger.isDebugging) {
			content = await new Promise<string>((resolve, reject) => {
				fs.readFile(filename, 'utf8', (err, data) => {
					if (err) {
						reject(err);
					} else {
						resolve(data);
					}
				});
			});
		} else {
			if (this._html !== undefined) return this._html;

			const doc = await workspace.openTextDocument(filename);
			content = doc.getText();
		}

		let html = content.replace(
			/#{root}/g,
			Uri.file(Container.context.asAbsolutePath('.')).with({ scheme: 'vscode-resource' }).toString(),
		);

		const bootstrap = await this.parseState(document);

		html = html.replace(
			/#{endOfBody}/i,
			`<script type="text/javascript" nonce="Z2l0bGVucy1ib290c3RyYXA=">window.bootstrap = ${JSON.stringify(
				bootstrap,
			)};</script>`,
		);

		this._html = html;
		return html;
	}
}
