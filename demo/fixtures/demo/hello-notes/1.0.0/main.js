// DEMO FIXTURE: a small, benign plugin used to demonstrate the marketplace.
const { Plugin, Notice } = require("obsidian");

module.exports = class HelloNotes extends Plugin {
  onload() {
    this.addCommand({
      id: "insert-today",
      name: "Insert today's date",
      editorCallback: (editor) => editor.replaceSelection(new Date().toISOString().slice(0, 10)),
    });
    new Notice("Hello Notes 1.0.0 loaded");
  }
};
