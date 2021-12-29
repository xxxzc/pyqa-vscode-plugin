const vscode = require('vscode');
const fetch = require('node-fetch')

const cp = "pyqa-vscode."
const sp = "pyqaPlugin."
const feedbackId = cp + 'feedback'
const restartId = cp + 'restart'
const completeId = cp + "complete"

function activate(context) {
    var cfg = vscode.workspace.getConfiguration()
    const server = cfg.get(sp+"server")
    const uuid = cfg.get(sp+"uuid")

    var triggers = new Set(...cfg.get(sp+"triggers"))
    var autoSuggestDelay = cfg.get(sp+"autoSuggestDelay")

    context.subscriptions.push(vscode.commands.registerCommand(
        feedbackId, function () {
            // vscode.window.showInformationMessage('pyqa:enable');
            fetch(server + "/suggest/feedback", { 
                    method: "post", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({uuid: uuid }) })
            .then(response => response.json()).then(data => {
                vscode.window.showInformationMessage(data.msg)
            })
        }
    ));
    
    context.subscriptions.push(vscode.commands.registerCommand(
        completeId, function () {
            KeyTrigger = '?'
            vscode.commands.executeCommand('editor.action.triggerSuggest')
        }
    ));

    async function complete(text, position, trigger) {
        let response = await fetch(server + "/suggest/answer", {
            method: "post", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                    text: text, trigger: trigger,
                    row: position.line, col: position.character-1,
                    commands: { "feedback": feedbackId }, 
                    uuid: uuid
            })
        })
        return response.json()
    }

    var results = null;
    var cursorTimeout = undefined
    function triggerSuggest(code, position) {
        position.character += 1
        complete(code, position, ' ').then(
            res => {
                if (res && res.items && res.items.length) {
                    results = res;
                    vscode.commands.executeCommand('editor.action.triggerSuggest')
                }
            }
        )
    }

    vscode.window.onDidChangeTextEditorSelection(e => {
        results = null;
        clearTimeout(cursorTimeout)
        let ch = ''
        let pos = e.textEditor.selection.active
        position = {line: pos._line, character: pos._character}
        if (position.character == 0)
            ch = undefined
        else
            ch = e.textEditor.document.lineAt(position.line).text[position.character-1]
        if (!ch || ch == '' || triggers.has(ch)) {
            return
        }
        if (autoSuggestDelay > 0) {
            cursorTimeout = setTimeout(triggerSuggest, Math.max(autoSuggestDelay, 400), 
                                        e.textEditor.document.getText(), position)
        }
    }) 
    
	let completeDisposable = vscode.languages.registerCompletionItemProvider("python", {
        provideCompletionItems: async function (document, position, token, ctx) {
            let trigger = ctx.triggerCharacter;
            if (!trigger && results !== null) {
                let result = JSON.parse(JSON.stringify(results))
                results = null
                return result
            }
            // autocomplete by KeyTrigger
            let pos = {line: position.line, character: position.character}
            if (KeyTrigger !== '') {
                trigger = KeyTrigger
                pos.character += 1
            }
            KeyTrigger = ''
            results = null;
            if (!trigger) return null;
            return complete(document.getText(), pos, trigger);
        }
	}, ...triggers)

    context.subscriptions.push(completeDisposable)
}

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
