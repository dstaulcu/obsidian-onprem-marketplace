import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, apiVersion } from "obsidian";
import { compareSemver, type IndexEntry, type TrustMode } from "@om/shared";
import { fetchIndex, reportUrl } from "./registry";
import { install, installedVersion, isCompatible, resolveVersion, uninstall, updatesAvailable, type Trust } from "./installer";

interface Settings { registryUrl: string; checkIntervalMinutes: number; trustMode: TrustMode; publicKey: string; }
const DEFAULTS: Settings = { registryUrl: "https://obsidian-registry.example.internal", checkIntervalMinutes: 240, trustMode: "off", publicKey: "" };

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
        try {
          const cur = installedVersion(this.app, u.id);
          const target = await resolveVersion(this.settings.registryUrl, u.id, this.trust);
          if (cur && compareSemver(target.entry.version, cur) <= 0) continue; // newest approved is not newer than what is installed
          const r = await install(this.app, this.settings.registryUrl, u.id, this.trust, target.entry.version);
          new Notice(`Updated ${u.name} to ${r.version}${r.approved || this.settings.trustMode === "off" ? "" : " (not approved)"}`);
        }
        catch (e) { new Notice(`Failed to update ${u.name}: ${(e as Error).message}`, 10000); }
      }
      if (!updates.length) new Notice("All internal plugins are up to date.");
    } catch (e) { new Notice(`Registry unreachable: ${(e as Error).message}`); }
  }

  get trust(): Trust { return { mode: this.settings.trustMode, publicKey: this.settings.publicKey }; }

  saveSettings() { return this.saveData(this.settings); }
}

class MarketplaceModal extends Modal {
  private entries: IndexEntry[] = [];
  private approved = new Map<string, boolean>();
  private query = "";
  constructor(app: App, private plugin: InternalMarketplace) { super(app); }

  async onOpen() {
    this.modalEl.addClass("mod-community-modal");
    this.contentEl.createEl("h2", { text: "On-Prem Marketplace" });
    new Setting(this.contentEl).addSearch((s) =>
      s.setPlaceholder("Search plugins").onChange((v) => { this.query = v.toLowerCase(); this.render(); }));
    this.listEl = this.contentEl.createDiv();
    this.listEl.setText("Loading…");
    try {
      this.entries = await fetchIndex(this.plugin.settings.registryUrl);
      if (this.plugin.settings.trustMode !== "off") {
        const t = this.plugin.trust;
        await Promise.all(this.entries.map(async (e) => {
          try { this.approved.set(e.id, (await resolveVersion(this.plugin.settings.registryUrl, e.id, { ...t, mode: "warn" }, e.latestVersion)).approved); }
          catch { this.approved.set(e.id, false); }
        }));
      }
      this.render();
    }
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
      if (this.plugin.settings.trustMode !== "off") {
        const ok = !!this.approved.get(e.id);
        const badge = s.nameEl.createSpan({ text: ok ? "approved" : "not approved" });
        badge.setCssStyles({
          marginLeft: "8px", padding: "1px 8px", borderRadius: "999px", fontSize: "var(--font-ui-smaller)", fontWeight: "600",
          border: "1px solid currentColor", color: ok ? "var(--color-green)" : "var(--color-orange)",
        });
        s.descEl.createEl("br");
        s.descEl.createEl("a", { text: "Review report", href: reportUrl(this.plugin.settings.registryUrl, e.id, e.latestVersion) });
      }
      const hasUpdate = cur !== null && cur !== e.latestVersion;
      if (!blocked && (cur === null || hasUpdate))
        s.addButton((b) => b.setButtonText(cur ? "Update" : "Install").setCta().onClick(async () => {
          b.setDisabled(true);
          try {
            const r = await install(this.app, this.plugin.settings.registryUrl, e.id, this.plugin.trust);
            new Notice(`Installed ${e.name} ${r.version}${r.approved || this.plugin.settings.trustMode === "off" ? "" : " (NOT approved)"}`);
          }
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
    new Setting(this.containerEl).setName("Trust mode")
      .setDesc("off: no checks. warn: install anything but flag unapproved. require-signed: only install versions signed by the admin key.")
      .addDropdown((d) => d.addOptions({ "off": "off", "warn": "warn", "require-signed": "require-signed" })
        .setValue(this.plugin.settings.trustMode)
        .onChange(async (v) => { this.plugin.settings.trustMode = v as TrustMode; await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("Pinned public key").setDesc("Base64 SPKI key from public-key.txt. Set at bootstrap; never fetched from the registry.")
      .addTextArea((t) => t.setValue(this.plugin.settings.publicKey).onChange(async (v) => { this.plugin.settings.publicKey = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName("Check for updates now").addButton((b) => b.setButtonText("Check").onClick(() => this.plugin.checkUpdates(true)));
  }
}
