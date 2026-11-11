import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, apiVersion } from "obsidian";
import type { IndexEntry } from "@om/shared";
import { fetchIndex } from "./registry";
import { install, installedVersion, isCompatible, uninstall, updatesAvailable } from "./installer";

interface Settings { registryUrl: string; checkIntervalMinutes: number; }
const DEFAULTS: Settings = { registryUrl: "https://obsidian-registry.example.internal", checkIntervalMinutes: 240 };

export default class InternalMarketplace extends Plugin {
  settings!: Settings;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addRibbonIcon("store", "On-Prem Marketplace", () => new MarketplaceModal(this.app, this).open());
    this.addCommand({ id: "open", name: "Browse internal plugins", callback: () => new MarketplaceModal(this.app, this).open() });
    this.addCommand({ id: "update-all", name: "Update all marketplace plugins", callback: () => this.updateAll() });
    this.addSettingTab(new SettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.checkUpdates(false));
    const ms = Math.max(5, this.settings.checkIntervalMinutes) * 60_000;
    this.registerInterval(window.setInterval(() => this.checkUpdates(false), ms));
  }

  async checkUpdates(verbose: boolean) {
    try {
      const updates = updatesAvailable(this.app, await fetchIndex(this.settings.registryUrl));
      if (updates.length) new Notice(`On-Prem Marketplace: updates for ${updates.map((u) => u.name).join(", ")}. Run "Update all marketplace plugins".`, 10000);
      else if (verbose) new Notice("All internal plugins are up to date.");
    } catch (e) {
      if (verbose) new Notice(`Registry unreachable: ${(e as Error).message}`);
    }
  }

  async updateAll() {
    try {
      const updates = updatesAvailable(this.app, await fetchIndex(this.settings.registryUrl));
      for (const u of updates) {
        try { await install(this.app, this.settings.registryUrl, u.id); new Notice(`Updated ${u.name} to ${u.latestVersion}`); }
        catch (e) { new Notice(`Failed to update ${u.name}: ${(e as Error).message}`, 10000); }
      }
      if (!updates.length) new Notice("All internal plugins are up to date.");
    } catch (e) { new Notice(`Registry unreachable: ${(e as Error).message}`); }
  }

  saveSettings() { return this.saveData(this.settings); }
}

class MarketplaceModal extends Modal {
  private entries: IndexEntry[] = [];
  private query = "";
  constructor(app: App, private plugin: InternalMarketplace) { super(app); }

  async onOpen() {
    this.modalEl.addClass("mod-community-modal");
    this.contentEl.createEl("h2", { text: "On-Prem Marketplace" });
    new Setting(this.contentEl).addSearch((s) =>
      s.setPlaceholder("Search plugins").onChange((v) => { this.query = v.toLowerCase(); this.render(); }));
    this.listEl = this.contentEl.createDiv();
    this.listEl.setText("Loading…");
    try { this.entries = await fetchIndex(this.plugin.settings.registryUrl); this.render(); }
    catch (e) { this.listEl.setText(`Could not reach registry: ${(e as Error).message}`); }
  }

  private listEl!: HTMLElement;

  private render() {
    this.listEl.empty();
    const shown = this.entries.filter((e) => `${e.name} ${e.description} ${e.author}`.toLowerCase().includes(this.query));
    if (!shown.length) this.listEl.setText("No plugins found.");
    for (const e of shown) {
      const cur = installedVersion(this.app, e.id);
      const blocked = isCompatible(e, apiVersion, Platform.isMobile);
      const s = new Setting(this.listEl).setName(`${e.name} (${e.latestVersion})`)
        .setDesc(`${e.description} — ${e.author}${cur ? ` · installed ${cur}` : ""}${blocked ? ` · ${blocked}` : ""}`);
      const hasUpdate = cur !== null && cur !== e.latestVersion;
      if (!blocked && (cur === null || hasUpdate))
        s.addButton((b) => b.setButtonText(cur ? "Update" : "Install").setCta().onClick(async () => {
          b.setDisabled(true);
          try { await install(this.app, this.plugin.settings.registryUrl, e.id); new Notice(`Installed ${e.name}`); }
          catch (err) { new Notice(`Install failed: ${(err as Error).message}`, 10000); }
          this.render();
        }));
      if (cur && e.id !== "onprem-marketplace")
        s.addButton((b) => b.setButtonText("Uninstall").onClick(async () => {
          try { await uninstall(this.app, e.id); } catch (err) { new Notice(`Uninstall failed: ${(err as Error).message}`); }
          this.render();
        }));
    }
  }

  onClose() { this.contentEl.empty(); }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: InternalMarketplace) { super(app, plugin); }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Registry URL").setDesc("Base URL of the internal registry (contains index.json).")
      .addText((t) => t.setValue(this.plugin.settings.registryUrl).onChange(async (v) => { this.plugin.settings.registryUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("Update check interval (minutes)")
      .addText((t) => t.setValue(String(this.plugin.settings.checkIntervalMinutes)).onChange(async (v) => { this.plugin.settings.checkIntervalMinutes = Number(v) || DEFAULTS.checkIntervalMinutes; await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("Check for updates now").addButton((b) => b.setButtonText("Check").onClick(() => this.plugin.checkUpdates(true)));
  }
}
