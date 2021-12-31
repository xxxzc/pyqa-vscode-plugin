const vscode = require('vscode');
const fetch = require('node-fetch');

function alertMsg(msg) {
    vscode.window.showInformationMessage(msg)
}

function checkFileExt(editor) {
    if (editor.document.fileName.endsWith('.py')) {
        return true
    }
    return false
}

async function post(url, data) {
    const res = await fetch(url, {
        method: "post", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });
    return await res.json();
}

function convertCmpList(list) {
    // We can't directly transfer MarkdownString from python
    for (let item of list.items) {
        // MarkdownString
        if (item.documentation.supportThemeIcons != undefined) {
            let doc = new vscode.MarkdownString(item.documentation.value, item.documentation.supportThemeIcons)
            doc.isTrusted = item.documentation.isTrusted
            doc.supportHtml = item.documentation.supportHtml
            item.documentation = doc
        }
    }
    return list
}

class PyqaPlugin {
    constructor() {
        this.updateConfig()
        this.commands = {}
        this.keyTrigger = ''
        this.results = null
        this.cursorTimeout = null
        this.disposes = []
        this.prefix = 'pyqa-plugin.'
        this.triggers = ['?', '!']
        this.minAutoSuggestDelay = 400
    }

    triggerSuggest(trigger=' ') {
        this.keyTrigger = trigger
        vscode.commands.executeCommand('editor.action.triggerSuggest')
    }

    get_row_col(pos) {
        if (pos._line) {
            return [pos._line, pos._character-1]
        }
        return [pos.line, pos.character-1]
    }

    lineAt(e, row) {
        return e.textEditor.document.lineAt(row)
    }

    get_cursor(e) {
        let ch = undefined
        let [row, col] = this.get_row_col(e.textEditor.selection.active)
        if (col > -1) 
            ch = this.lineAt(e, row).text[col]
        return [row, col, ch]
    }

    feedback() {
        post(this.server + "/suggest/feedback", {uuid: this.uuid}).then(
            data => alertMsg(data.msg)
        )
    }

    addCommand(name, func) {
        let id = this.prefix + name
        this.disposes.push(
            vscode.commands.registerTextEditorCommand(id, func)
        )
        this.commands[name] = id
    }

    async complete(text, row, col, trigger) {
        let lines = text.split('\n').slice(0, row+this.extraRows)
        return post(this.server + "/suggest/answer", {
            lines: lines, trigger: trigger,
            row: row, col: col, 
            uuid: this.uuid
        })
    }

    delaySuggest(code, row, col) {
        // trigger ' ' to disable some features
        this.complete(code, row, col, ' ').then(
            res => {
                if (res && res.items && res.items.length) {
                    this.results = res
                    this.triggerSuggest(' ')
                }
            }
        )
    }

    deactivate() {
        clearTimeout(this.cursorTimeout)
        for (let dispose of this.disposes) {
            dispose.dispose()
        }
        this.disposes = []
    }

    async provideCompletionItems(model, position, token, context) {
        let trigger = context.triggerCharacter;
        if (this.keyTrigger === ' ' && this.results !== null) {
            let result = convertCmpList(this.results)
            this.results = null;
            return result
        }
        let [row, col] = this.get_row_col(position)
        // autocomplete by keyTrigger
        if (this.keyTrigger !== '') {
            trigger = this.keyTrigger
            col += 1
        }
        this.keyTrigger = ''
        this.results = null;
        if (!trigger) return null;
        let result = await this.complete(model.getText(), row, col, trigger)
        return convertCmpList(result)
    }

    /**
     * trigger suggest when cursor stopped
     * @param {*} e 
     * @returns 
     */
     triggerSuggestWhenCursorStopped(e) {
        if (!checkFileExt(e.textEditor)) return;
        this.results = null;
        this.keyTrigger = '';
        clearTimeout(this.cursorTimeout)
        // 1 - keyboard/snippet 2 - mouse 3 - command
        if (e.kind !== 1 && e.kind !== undefined) {
            // 其他方式触发实际体验有点烦人，先关了，后续再考虑优化
            return
        }
        let [row, col, ch] = this.get_cursor(e)
        if (!ch || ch == '' || this.triggers.indexOf(ch) > -1) {
            return
        }
        if (e.kind === undefined && col+1 !== this.lineAt(e, row).text.length) {
            // 退格的 kind 是 undefined，当退格时，也触发 suggest
            return
        }
        if (this.autoSuggestDelay > 0) {
            this.cursorTimeout = setTimeout((code, row, col) => this.delaySuggest(code, row, col), 
                Math.max(this.minAutoSuggestDelay, this.autoSuggestDelay), 
                e.textEditor.document.getText(), row, col+1)
        }
    }

    updateConfig() {
        var cfg = vscode.workspace.getConfiguration()
        this.server = cfg.get(this.prefix+"server")
        this.uuid = cfg.get(this.prefix+"uuid")
        this.autoSuggestDelay = cfg.get(this.prefix+"autoSuggestDelay")
    }

    async activate(context) {
        this.deactivate()

        this.updateConfig()

        let conf = await post(this.server + '/suggest/conf', {uuid: this.uuid})
        this.triggers = conf.triggers || this.triggers
        this.minAutoSuggestDelay = conf.minAutoSuggestDelay || this.minAutoSuggestDelay
        this.extraRows = conf.extraRows || this.extraRows

        this.addCommand('feedback', (editor) => {
            if (checkFileExt(editor))
                this.feedback()
        })
        this.addCommand('suggest', (editor) => {
            if (checkFileExt(editor))
                this.triggerSuggest('?')
        })

        let cursorDispose = vscode.window.onDidChangeTextEditorSelection(
            e => this.triggerSuggestWhenCursorStopped(e)
        )
        this.disposes.push(cursorDispose)

        let completeDispose = vscode.languages.registerCompletionItemProvider('python', {
            provideCompletionItems: (model, position, context, token) => this.provideCompletionItems(model, position, context, token)
        }, ...this.triggers)
        this.disposes.push(completeDispose)

        for (let dispose of this.disposes) {
            context.subscriptions.push(dispose)
        }
    }
}

var pyqaPlugin = null;

async function activate(context) {
    pyqaPlugin = new PyqaPlugin()
    await pyqaPlugin.activate(context)
    context.subscriptions.push(
        vscode.commands.registerCommand(pyqaPlugin.prefix+"enable", () => pyqaPlugin.activate(context))
    )
    context.subscriptions.push(
        vscode.commands.registerCommand(pyqaPlugin.prefix+"disable", () => pyqaPlugin.deactivate())
    )
}

// this method is called when your extension is deactivated
function deactivate() {
    if (pyqaPlugin) {
        pyqaPlugin.deactivate()
        pyqaPlugin = null;
    }
}

module.exports = {
	activate,
	deactivate
}
